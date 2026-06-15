"""Serve the local web app with explicit UTF-8 text content types."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


HOST = "127.0.0.1"
PORT = 5500
UTF8_TYPES = {
    "application/javascript",
    "application/json",
    "text/css",
    "text/html",
    "text/plain",
}


class UTF8RequestHandler(SimpleHTTPRequestHandler):
    def guess_type(self, path: str) -> str:
        content_type = super().guess_type(path)
        if content_type in UTF8_TYPES:
            return f"{content_type}; charset=utf-8"
        return content_type


if __name__ == "__main__":
    print(f"Serving local web app at http://localhost:{PORT}")
    ThreadingHTTPServer((HOST, PORT), UTF8RequestHandler).serve_forever()
