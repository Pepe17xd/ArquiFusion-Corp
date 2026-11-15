"""Gemini Developer API provider. Imports the SDK lazily so unit tests run without it."""
from __future__ import annotations

import json
import os
from typing import Any

MAX_MACHINES = 200
PRIORITIES = {"high", "medium"}
CATEGORIES = {"maintenance", "operations"}

SYSTEM_INSTRUCTION = (
    "You are a heavy-machinery fleet maintenance analyst. You receive a JSON array of machines. "
    'Reply ONLY with a JSON object of the form {"recommendations": [...]}. '
    "Each recommendation has: machineId (must match an input machine), "
    'priority ("high" or "medium"), category ("maintenance" or "operations"), '
    "title, reason, suggestedAction (short strings, written in Spanish), and "
    "evidence (an object whose values are numbers or strings copied from the input). "
    "Use only facts present in the input; never invent readings. "
    "If nothing needs attention, return an empty list."
)


class ProviderFailure(RuntimeError):
    """The model call failed or returned unusable output. str(error) is a safe code."""


def is_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def model_name() -> str:
    return os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")


def _generate(machines: list[dict[str, Any]]) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    response = client.models.generate_content(
        model=model_name(),
        contents=json.dumps(machines, ensure_ascii=False),
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            response_mime_type="application/json",
            temperature=0.2,
            max_output_tokens=4096,
        ),
    )
    return response.text or ""


def sanitize(parsed: Any, machine_ids: set[str]) -> list[dict[str, Any]]:
    items = parsed.get("recommendations") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        raise ProviderFailure("invalid-model-output")
    cleaned: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("machineId") not in machine_ids:
            continue
        if item.get("priority") not in PRIORITIES or item.get("category") not in CATEGORIES:
            continue
        texts = {key: item.get(key) for key in ("title", "reason", "suggestedAction")}
        if not all(isinstance(value, str) and value.strip() for value in texts.values()):
            continue
        raw_evidence = item.get("evidence") if isinstance(item.get("evidence"), dict) else {}
        evidence = {
            str(key): value
            for key, value in raw_evidence.items()
            if isinstance(value, (int, float, str)) and not isinstance(value, bool)
        }
        cleaned.append({
            "machineId": item["machineId"],
            "priority": item["priority"],
            "category": item["category"],
            **{key: value.strip() for key, value in texts.items()},
            "evidence": evidence,
        })
    return cleaned[:100]


def analyze(machines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    subset = machines[:MAX_MACHINES]
    ids = {m.get("machineId") for m in subset if isinstance(m.get("machineId"), str)}
    try:
        parsed = json.loads(_generate(subset))
    except ProviderFailure:
        raise
    except Exception as error:  # SDK, network, quota, JSON: never leak details to the caller
        code = getattr(error, "code", None)
        print(json.dumps({"event": "provider.error", "type": type(error).__name__, "code": code}), flush=True)
        raise ProviderFailure("rate-limited" if code == 429 else "provider-error") from error
    return sanitize(parsed, ids)