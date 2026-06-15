"""Local-only HTTP API for Azure OpenAI travel-plan generation.

This server is intended for local development and demonstrations. Azure OpenAI
credentials remain in the project-root .env file and are never returned to the
browser.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from generate_azure_travel_plan import (
    build_prompt,
    call_azure_openai,
    extract_ab_test_context,
    load_project_data,
    validate_environment,
)


HOST = "127.0.0.1"
PORT = 8000
MAX_REQUEST_BYTES = 2_000_000
ALLOWED_ORIGINS = {
    "http://localhost:5500",
    "http://127.0.0.1:5500",
}


def safe_error_message(exc: Exception, settings: dict[str, str]) -> str:
    message = str(exc)
    for name, value in settings.items():
        if value:
            message = message.replace(value, f"[{name} hidden]")
    return message or exc.__class__.__name__


class LocalAIRequestHandler(BaseHTTPRequestHandler):
    server_version = "LocalAITravelPlanServer/1.0"

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/generate-plan":
            self.send_json(404, {"ok": False, "error": "Not found"})
            return
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_json(403, {"ok": False, "error": "Origin is not allowed"})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type != "application/json":
            self.send_json(415, {"ok": False, "error": "Content-Type must be application/json"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                raise ValueError("JSON payload is required")
            if content_length > MAX_REQUEST_BYTES:
                self.send_json(413, {"ok": False, "error": "Request payload is too large"})
                return
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON payload must be an object")

            extracted = extract_ab_test_context(payload)
            prompt = build_prompt(payload, extracted, self.server.project_data)
            plan_markdown = call_azure_openai(self.server.settings, prompt)
            self.send_json(
                200,
                {
                    "ok": True,
                    "plan_markdown": plan_markdown,
                    "model": self.server.settings["AZURE_OPENAI_DEPLOYMENT"],
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            error = safe_error_message(exc, self.server.settings)
            print(f"Generation failed: {error}", file=sys.stderr)
            self.send_json(
                500,
                {
                    "ok": False,
                    "error": "Travel-plan generation failed. Check the local AI server log.",
                },
            )

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[local-ai] {self.address_string()} - {format % args}")


class LocalAIServer(ThreadingHTTPServer):
    settings: dict[str, str]
    project_data: dict[str, str]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.shutdown_requested = False

    def shutdown(self) -> None:
        self.shutdown_requested = True
        super().shutdown()


def main() -> int:
    try:
        settings = validate_environment()
        project_data = load_project_data()
    except ValueError as exc:
        print(f"Startup error: {exc}", file=sys.stderr)
        return 1

    server = LocalAIServer((HOST, PORT), LocalAIRequestHandler)
    server.settings = settings
    server.project_data = project_data

    print("Local Azure OpenAI travel-plan server")
    print("Local development/demo only. Credentials remain in the project-root .env.")
    print(f"Endpoint: http://localhost:{PORT}/generate-plan")
    print("Allowed frontend: http://localhost:5500")
    print("Stop the server with Ctrl+C.")
    stopping = False
    try:
        while not server.shutdown_requested:
            server.serve_forever()
            if not server.shutdown_requested:
                print(
                    "serve_forever() returned unexpectedly; restarting the serve loop.",
                    file=sys.stderr,
                )
    except KeyboardInterrupt:
        stopping = True
    finally:
        server.server_close()
        if stopping or server.shutdown_requested:
            print("\nStopping local AI server.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
