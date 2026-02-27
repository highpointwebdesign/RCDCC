#!/usr/bin/env python3
"""
Simple HTTP server for serving the active suspension web interface.
Listens on 0.0.0.0:8080 to be accessible from all computers on the network.
"""

import http.server
import socketserver
import os
from pathlib import Path

# Change to the html directory
html_dir = Path(__file__).parent / "html"
os.chdir(html_dir)

PORT = 8080
BIND_ADDRESS = "0.0.0.0"

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add headers to prevent caching for development
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def log_message(self, format, *args):
        # Custom logging
        print(f"[{self.log_date_time_string()}] {format % args}")

if __name__ == "__main__":
    handler = MyHTTPRequestHandler
    
    with socketserver.TCPServer((BIND_ADDRESS, PORT), handler) as httpd:
        print(f"\n{'='*60}")
        print(f"Active Suspension Web Server")
        print(f"{'='*60}")
        print(f"Serving files from: {html_dir}")
        print(f"Listening on: http://0.0.0.0:{PORT}")
        print(f"Access from this computer: http://localhost:{PORT}")
        print(f"Access from network: http://<your-computer-ip>:{PORT}")
        print(f"{'='*60}")
        print(f"Press Ctrl+C to stop the server\n")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\nServer stopped.")
