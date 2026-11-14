from __future__ import annotations

from datetime import datetime
from pathlib import Path
import json
from typing import Any

REPOSITORY_SCHEMA = Path(__file__).resolve().parents[4] / "shared" / "contracts" / "events.schema.json"
CONTAINER_SCHEMA = Path("/app/shared/contracts/events.schema.json")
SCHEMA_PATH = REPOSITORY_SCHEMA if REPOSITORY_SCHEMA.is_file() else CONTAINER_SCHEMA
EVENT_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
EVENT_TYPES = set(EVENT_SCHEMA["properties"]["eventType"]["enum"])
REQUIRED = EVENT_SCHEMA["required"]


def validate_event(value: Any) -> list[str]:
    """Validate the portable v1 envelope used by TypeScript and Python services."""
    if not isinstance(value, dict):
        return ["event must be an object"]
    errors: list[str] = []
    if set(value) != set(REQUIRED):
        errors.append("event fields do not match the v1 schema")
    for field in ("eventId", "taskId", "executionId", "correlationId", "source"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            errors.append(f"{field} must be a non-empty string")
    if value.get("eventType") not in EVENT_TYPES:
        errors.append("eventType is unsupported")
    if value.get("schemaVersion") != "1.0":
        errors.append("schemaVersion must be 1.0")
    if not isinstance(value.get("payload"), dict):
        errors.append("payload must be an object")
    timestamp = value.get("timestamp")
    if not isinstance(timestamp, str):
        errors.append("timestamp must be an ISO date-time")
    else:
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if parsed.utcoffset() is None:
                errors.append("timestamp must include a timezone")
        except ValueError:
            errors.append("timestamp must be an ISO date-time")
    return errors
