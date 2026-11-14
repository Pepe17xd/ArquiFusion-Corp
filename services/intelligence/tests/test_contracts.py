import unittest

from arquifusion_intelligence.contracts import validate_event


class EventContractTest(unittest.TestCase):
    def setUp(self):
        self.event = {
            "eventId": "e-1", "eventType": "IntelligenceAnalysisRequested", "schemaVersion": "1.0",
            "timestamp": "2026-11-14T00:00:00Z", "tenantId": "tenant-a", "taskId": "t-1", "executionId": "x-1",
            "correlationId": "c-1", "source": "backend", "payload": {"machineIds": ["M-1"]},
        }

    def test_accepts_valid_shared_event(self):
        self.assertEqual(validate_event(self.event), [])

    def test_rejects_unknown_fields_and_unsupported_version(self):
        event = {**self.event, "schemaVersion": "9.0", "unexpectedField": "rejected"}
        self.assertIn("event fields do not match the v1 schema", validate_event(event))
        self.assertIn("schemaVersion must be 1.0", validate_event(event))


if __name__ == "__main__":
    unittest.main()
