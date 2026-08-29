#!/usr/bin/env python3
"""Serve the local boat telemetry dashboard and its current JSON data."""

import argparse
import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cloud_gemini_analyst import generate_gemini_analysis
from final_report import build_report, load_records
from gemma_advisor import get_gemma_coaching_advice


class DashboardHandler(SimpleHTTPRequestHandler):
    log_path: Path
    html_path: Path

    def send_json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - required by the stdlib handler
        if self.path in {"/", "/index.html"}:
            body = self.html_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/api/latest":
            try:
                records = load_records(self.log_path)
                self.send_json(records[-1] if records else {"state": "waiting"})
            except FileNotFoundError:
                self.send_json({"state": "waiting"})
            return

        if self.path == "/api/overall":
            try:
                self.send_json({"report": build_report(load_records(self.log_path))})
            except FileNotFoundError:
                self.send_json({"report": "Waiting for the first telemetry record."})
            return

        if self.path == "/api/gemma/advice":
            try:
                paddle_path = self.log_path.parent / "paddle-telemetry.jsonl"
                advice = get_gemma_coaching_advice(str(self.log_path), str(paddle_path))
                self.send_json(advice)
            except Exception as err:
                self.send_json({"status": "error", "advice": f"Gemma Edge Engine Error: {err}"})
            return

        if self.path == "/api/gemini/report":
            try:
                analysis = generate_gemini_analysis(str(self.log_path))
                self.send_json({"analysis": analysis})
            except Exception as err:
                self.send_json({"analysis": f"Gemini Cloud Error: {err}"})
            return

        if self.path == "/api/paddle/latest":
            try:
                paddle_path = self.log_path.parent / "paddle-telemetry.jsonl"
                if paddle_path.exists():
                    records = load_records(paddle_path)
                    self.send_json(records[-1] if records else {"state": "waiting"})
                else:
                    self.send_json({"state": "waiting"})
            except Exception:
                self.send_json({"state": "waiting"})
            return

        self.send_error(HTTPStatus.NOT_FOUND)


class DashboardServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default="data/boat-telemetry.jsonl")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    DashboardHandler.log_path = Path(args.log)
    DashboardHandler.html_path = Path(__file__).with_name("live_dashboard.html")
    try:
        server = DashboardServer(("127.0.0.1", args.port), DashboardHandler)
    except OSError as err:
        if err.errno == 98:
            print(f"Port {args.port} is already in use by another process.")
            print(f"You can view the existing dashboard at http://127.0.0.1:{args.port} or run with a different port using `--port {args.port + 1}`.")
            return
        raise

    print(f"Dashboard ready at http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
