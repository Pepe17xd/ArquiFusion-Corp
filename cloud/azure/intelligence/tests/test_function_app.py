from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class FakeHttpResponse:
    def __init__(self, body=None, status_code=200, headers=None, mimetype=None, charset=None):
        self.body = body if isinstance(body, bytes) else str(body or "").encode("utf-8")
        self.status_code = status_code
        self.headers = headers or {}
        self.mimetype = mimetype
        self.charset = charset

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class FakeHttpRequest:
    def __init__(self, body=b"", headers=None):
        self._body = body
        self.headers = headers or {}

    def get_body(self):
        return self._body


class FakeFunctionApp:
    def __init__(self, http_auth_level=None):
        self.http_auth_level = http_auth_level
        self.routes = {}

    def route(self, route, methods, auth_level=None):
        def decorate(function):
            self.routes[(route, tuple(methods))] = (function, auth_level)
            return function
        return decorate


def load_function_app():
    azure_module = types.ModuleType("azure")
    functions_module = types.ModuleType("azure.functions")
    functions_module.AuthLevel = types.SimpleNamespace(ANONYMOUS="anonymous")
    functions_module.FunctionApp = FakeFunctionApp
    functions_module.HttpRequest = FakeHttpRequest
    functions_module.HttpResponse = FakeHttpResponse
    azure_module.functions = functions_module
    with patch.dict(sys.modules, {"azure": azure_module, "azure.functions": functions_module}):
        path = Path(__file__).resolve().parents[1] / "function_app.py"
        spec = importlib.util.spec_from_file_location("arquifusion_azure_function_app_test", path)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
    return module


APP = load_function_app()


def event():
    return {
        "eventId": "evt-1",
        "eventType": "IntelligenceAnalysisRequested",
        "schemaVersion": "1.0",
        "timestamp": "2026-11-15T12:00:00Z",
        "tenantId": "tenant-a",
        "taskId": "task-a",
        "executionId": "exec-a",
        "correlationId": "corr-a",
        "source": "arquifusion-mailops",
        "payload": {"machines": [{"machineId": "machine-1", "status": "alert", "temperature": 94}]},
    }


def request(value, token="test-bearer"):
    return FakeHttpRequest(json.dumps(value).encode("utf-8"), {"authorization": "Bearer " + token})


class AzureFunctionTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict("os.environ", {"INTELLIGENCE_API_KEY": "test-bearer"})
        self.env.start()
        self.configured = patch.object(APP.provider, "is_configured", return_value=True)
        self.configured.start()
        self.analyze = patch.object(APP.provider, "analyze", return_value=[])
        self.analyze.start()
        self.model = patch.object(APP.provider, "model_name", return_value="test-model")
        self.model.start()

    def tearDown(self):
        self.model.stop()
        self.analyze.stop()
        self.configured.stop()
        self.env.stop()

    def test_http_routes_have_exact_paths_and_no_extra_api_prefix(self):
        self.assertEqual(APP.app.http_auth_level, "anonymous")
        self.assertIn(("health", ("GET",)), APP.app.routes)
        self.assertIn(("v1/intelligence/analyze", ("POST",)), APP.app.routes)
        self.assertEqual(APP.app.routes[("v1/intelligence/analyze", ("POST",))][1], "anonymous")

    def test_health_contract_matches_existing_gcp_service(self):
        response = APP.health(FakeHttpRequest())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "intelligenceProvider": "gemini-api"})

    def test_valid_v1_event_returns_completed_event_and_preserves_all_correlation_fields(self):
        response = APP.analyze(request(event()))
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["eventType"], "IntelligenceAnalysisCompleted")
        self.assertEqual(body["schemaVersion"], "1.0")
        for field in ("tenantId", "taskId", "executionId", "correlationId"):
            self.assertEqual(body[field], event()[field])
        self.assertEqual(body["source"], "arquifusion-intelligence")
        self.assertEqual(body["payload"], {"recommendations": [], "provider": "gemini-api", "model": "test-model"})
        APP.provider.analyze.assert_called_once_with(event()["payload"]["machines"])

    def test_missing_or_wrong_bearer_is_rejected_without_invoking_provider(self):
        APP.provider.analyze.reset_mock()
        no_auth = APP.analyze(FakeHttpRequest(json.dumps(event()).encode("utf-8"), {}))
        wrong_auth = APP.analyze(request(event(), "wrong-secret"))
        self.assertEqual(no_auth.status_code, 401)
        self.assertEqual(wrong_auth.status_code, 401)
        APP.provider.analyze.assert_not_called()

    def test_missing_api_key_fails_closed(self):
        with patch.dict("os.environ", {"INTELLIGENCE_API_KEY": ""}):
            response = APP.analyze(request(event()))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], "auth-not-configured")

    def test_invalid_envelope_event_type_and_machine_payload_are_rejected(self):
        invalid = event()
        del invalid["tenantId"]
        self.assertEqual(APP.analyze(request(invalid)).status_code, 400)
        unexpected = event()
        unexpected["eventType"] = "AgentTaskCompleted"
        self.assertEqual(APP.analyze(request(unexpected)).json()["error"], "unexpected-event-type")
        malformed_machines = event()
        malformed_machines["payload"]["machines"] = "not-an-array"
        self.assertEqual(APP.analyze(request(malformed_machines)).json()["error"], "invalid-payload")

    def test_invalid_utf8_json_and_large_payload_have_compatible_errors(self):
        self.assertEqual(APP.analyze(FakeHttpRequest(b"\xff", {"authorization": "Bearer test-bearer"})).status_code, 400)
        self.assertEqual(APP.analyze(FakeHttpRequest(b"{", {"authorization": "Bearer test-bearer"})).json()["error"], "invalid-json")
        self.assertEqual(APP.analyze(FakeHttpRequest(b" " * (APP.MAX_REQUEST_BYTES + 1), {"authorization": "Bearer test-bearer"})).status_code, 413)

    def test_gemini_unavailable_and_transient_provider_errors_keep_gcp_status_codes(self):
        with patch.object(APP.provider, "is_configured", return_value=False):
            unavailable = APP.analyze(request(event()))
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(unavailable.json()["correlationId"], "corr-a")
        with patch.object(APP.provider, "analyze", side_effect=APP.provider.ProviderFailure("rate-limited")):
            limited = APP.analyze(request(event()))
        self.assertEqual(limited.status_code, 429)
        with patch.object(APP.provider, "analyze", side_effect=APP.provider.ProviderFailure("provider-error")):
            failure = APP.analyze(request(event()))
        self.assertEqual(failure.status_code, 502)

    def test_event_validation_uses_the_shared_contract_function(self):
        with patch.object(APP, "validate_event", return_value=["bad envelope"]) as validate:
            response = APP.analyze(request(event()))
        validate.assert_called_once()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"], ["bad envelope"])


if __name__ == "__main__":
    unittest.main()
