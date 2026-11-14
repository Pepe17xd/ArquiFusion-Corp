from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os

from .contracts import validate_event


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self.respond(200, {"status": "ok", "intelligenceProvider": "not-configured"})
        self.respond(404, {"error": "not-found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/v1/intelligence/analyze":
            return self.respond(404, {"error": "not-found"})
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
        # No model provider is wired in this repository; never fabricate an analysis.
        self.respond(503, {"error": "provider-not-configured", "correlationId": event["correlationId"]})

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
