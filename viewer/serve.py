#!/usr/bin/env python3
import http.server
import os
import posixpath
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(path)
        path = posixpath.normpath(path)
        parts = path.split("/")
        parts = [p for p in parts if p]
        trail = os.sep.join(parts)

        local = os.path.join(ROOT, trail)
        if os.path.isfile(local):
            return local

        project = os.path.join(PROJECT, trail)
        if os.path.isfile(project):
            return project

        return os.path.join(ROOT, "index.html")


if __name__ == "__main__":
    s = http.server.HTTPServer(("", 8765), Handler)
    print(f"Serving on http://localhost:8765")
    s.serve_forever()
