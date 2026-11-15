"""Azure Functions entry points delegating to the existing GCP intelligence package."""
from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
import sys
from typing import Any
from datetime import datetime, timezone
import uuid

import azure.functions as func

# During publish, publish.ps1 stages the exact shared package in this same path.
# Local development imports that package from the existing GCP service tree.
_project = Path(__file__).resolve().parent
_staged_source = _project / "cloud" / "gcp" / "intelligence" / "src"
_local_source = Path(__file__).resolve().parents[2] / "gcp" / "intelligence" / "src"
for _source in (_staged_source, _local_source):
    if _source.is_dir() and str(_source) not in sys.path:
        sys.path.insert(0, str(_source))

from arquifusion_intelligence import provider  # noqa: E402
from arquifusion_intelligence.contracts import validate_event  # noqa: E402

MAX_REQUEST_BYTES = 1024 * 1024
app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


def _response(status: int, data: dict[str, Any]) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        status_code=status,
        mimetype="application/json",
        charset="utf-8",
    )


def _authorized(header: str | None) -> bool:
    expected = os.environ.get("INTELLIGENCE_API_KEY", "")
    if not expected or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):].encode("utf-8"), expected.encode("utf-8"))


@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(_request: func.HttpRequest) -> func.HttpResponse:
    name = "gemini-api" if provider.is_configured() else "not-configured"
    return _response(200, {"status": "ok", "intelligenceProvider": name})


@app.route(route="v1/intelligence/analyze", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def analyze(request: func.HttpRequest) -> func.HttpResponse:
    if not os.environ.get("INTELLIGENCE_API_KEY"):
        return _response(503, {"error": "auth-not-configured"})
    if not _authorized(request.headers.get("authorization")):
        return _response(401, {"error": "unauthorized"})
    try:
        raw = request.get_body()
        if not raw or len(raw) > MAX_REQUEST_BYTES:
            return _response(413, {"error": "payload-size-invalid"})
        event = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return _response(400, {"error": "invalid-json"})
    errors = validate_event(event)
    if errors:
        return _response(400, {"error": "invalid-event", "details": errors})
    if event["eventType"] != "IntelligenceAnalysisRequested":
        return _response(400, {"error": "unexpected-event-type"})
    if not provider.is_configured():
        return _response(503, {"error": "provider-not-configured", "correlationId": event["correlationId"]})
    machines = event["payload"].get("machines")
    if not isinstance(machines, list) or not all(isinstance(machine, dict) for machine in machines):
        return _response(400, {"error": "invalid-payload", "details": ["payload.machines must be an array of objects"]})
    try:
        recommendations = provider.analyze(machines)
    except provider.ProviderFailure as failure:
        status = 429 if str(failure) == "rate-limited" else 502
        return _response(status, {"error": str(failure), "correlationId": event["correlationId"]})
    result = {
        "eventId": str(uuid.uuid4()),
        "eventType": "IntelligenceAnalysisCompleted",
        "schemaVersion": "1.0",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "tenantId": event["tenantId"],
        "taskId": event["taskId"],
        "executionId": event["executionId"],
        "correlationId": event["correlationId"],
        "source": "arquifusion-intelligence",
        "payload": {
            "recommendations": recommendations,
            "provider": "gemini-api",
            "model": provider.model_name(),
        },
    }
    return _response(200, result)
