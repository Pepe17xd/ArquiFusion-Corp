"""Run the real Python HTTP handler with a deterministic local-only provider."""
import os
import sys
from http.server import ThreadingHTTPServer

sys.path.insert(0, "cloud/gcp/intelligence/src")
from arquifusion_intelligence import __main__ as service

os.environ["INTELLIGENCE_API_KEY"] = "local-test-only"
service.provider.is_configured = lambda: True
service.provider.model_name = lambda: "local-mock"
service.provider.analyze = lambda machines: [{
    "machineId": machines[0]["machineId"], "priority": "high", "category": "maintenance",
    "title": "Revisar", "reason": "Estado de alerta", "suggestedAction": "Inspeccionar",
    "evidence": {"status": machines[0]["status"]},
}] if machines else []
server = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
print(server.server_port, flush=True)
server.serve_forever()
