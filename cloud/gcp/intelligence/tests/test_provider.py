import json
import os
import unittest
from unittest import mock

from arquifusion_intelligence import provider
from arquifusion_intelligence.__main__ import authorized

GOOD = {
    "machineId": "EXC-001", "priority": "high", "category": "maintenance",
    "title": "Revisar temperatura", "reason": "96 C", "suggestedAction": "Inspeccionar",
    "evidence": {"temperature": 96, "flag": True},
}


class QuotaError(Exception):
    code = 429


class ProviderTests(unittest.TestCase):
    def test_sanitize_drops_invalid_items_and_non_scalar_evidence(self):
        parsed = {"recommendations": [
            GOOD,
            {**GOOD, "machineId": "UNKNOWN"},
            {**GOOD, "priority": "urgent"},
            {**GOOD, "title": ""},
            "not-an-object",
        ]}
        result = provider.sanitize(parsed, {"EXC-001"})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["evidence"], {"temperature": 96})

    def test_sanitize_rejects_wrong_shape(self):
        with self.assertRaises(provider.ProviderFailure):
            provider.sanitize({"nope": []}, set())

    def test_analyze_uses_model_output(self):
        with mock.patch.object(provider, "_generate", return_value=json.dumps({"recommendations": [GOOD]})):
            result = provider.analyze([{"machineId": "EXC-001"}])
        self.assertEqual(result[0]["machineId"], "EXC-001")

    def test_analyze_maps_quota_errors(self):
        with mock.patch.object(provider, "_generate", side_effect=QuotaError()):
            with self.assertRaises(provider.ProviderFailure) as raised:
                provider.analyze([{"machineId": "EXC-001"}])
        self.assertEqual(str(raised.exception), "rate-limited")


class AuthTests(unittest.TestCase):
    def test_bearer_must_match(self):
        with mock.patch.dict(os.environ, {"INTELLIGENCE_API_KEY": "secret"}):
            self.assertTrue(authorized("Bearer secret"))
            self.assertFalse(authorized("Bearer wrong"))
            self.assertFalse(authorized(None))

    def test_missing_server_key_rejects_everything(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(authorized("Bearer anything"))


if __name__ == "__main__":
    unittest.main()