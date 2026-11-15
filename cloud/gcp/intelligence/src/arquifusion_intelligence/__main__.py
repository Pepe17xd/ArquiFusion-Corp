from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
import uuid

from . import provider
from .contracts import validate_event


def completed_event(request: dict, recommendations: list) -> dict:
    return {
        "eventId": str(uuid.uuid4()),
        "eventType": "IntelligenceAnalysisCompleted",
        "schemaVersion": "1.0",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "tenantId": request["tenantId"],
        "taskId": request["taskId"],
        "executionId": request["executionId"],
        "correlationId": request["correlationId"],
        "source": "arquifusion-intelligence",
        "payload": {
            "recommendations": recommendations,
            "provider": "gemini-api",
            "model": provider.model_name(),
        },
    }


def authorized(header: str | None) -> bool:
    expected = os.environ.get("INTELLIGENCE_API_KEY", "")
    if not expected or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):].encode(), expected.encode())


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            name = "gemini-api" if provider.is_configured() else "not-configured"
            return self.respond(200, {"status": "ok", "intelligenceProvider": name})
        self.respond(404, {"error": "not-found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/v1/intelligence/analyze":
            return self.respond(404, {"error": "not-found"})
        if not os.environ.get("INTELLIGENCE_API_KEY"):
            return self.respond(503, {"error": "auth-not-configured"})
        if not authorized(self.headers.get("authorization")):
            return self.respond(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 1 or length > 1024 * 1024:
                return self.respond(413, {"error": "payload-size-invalid"})
            event = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            return self.respond(400, {"error": "invalid-json"})
        errors = validate_event(event)
        if errors:
            return self.respond(400, {"error": "invalid-event", "details": errors})
        if event["eventType"] != "IntelligenceAnalysisRequested":
            return self.respond(400, {"error": "unexpected-event-type"})
        if not provider.is_configured():
            return self.respond(503, {"error": "provider-not-configured", "correlationId": event["correlationId"]})
        machines = event["payload"].get("machines")
        if not isinstance(machines, list) or not all(isinstance(m, dict) for m in machines):
            return self.respond(400, {"error": "invalid-payload", "details": ["payload.machines must be an array of objects"]})
        try:
            recommendations = provider.analyze(machines)
        except provider.ProviderFailure as failure:
            status = 429 if str(failure) == "rate-limited" else 502
            return self.respond(status, {"error": str(failure), "correlationId": event["correlationId"]})
        self.respond(200, completed_event(event, recommendations))

    def log_message(self, _format, *_args):
        return

    def respond(self, status: int, data: dict):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()