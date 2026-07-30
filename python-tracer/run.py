#!/usr/bin/env python3
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

MODELS = {
    "Tongyi-MAI/Z-Image-Turbo": {
        "args": [],
        "query": {
            "url": "http://localhost:8000/v1/images/generations",
            "body": {"prompt": "a red panda sitting on a park bench", "size": "512x512"},
        },
    },
    "Qwen/Qwen3-Omni-30B-A3B-Instruct": {
        "args": ["--quantization", "fp8"],
    },
}

HEALTH_URL = "http://localhost:8000/health"
POLL_INTERVAL = 10


def poll_health(pid):
    start = time.monotonic()
    while True:
        try:
            os.kill(pid, 0)
        except OSError:
            print(f"Process {pid} is dead", file=sys.stderr)
            return False

        try:
            resp = urllib.request.urlopen(HEALTH_URL, timeout=3)
            if resp.status == 200:
                elapsed = int(time.monotonic() - start)
                print(f"Server ready ({elapsed // 60}m {elapsed % 60}s)")
                return True
        except Exception:
            pass

        elapsed = int(time.monotonic() - start)
        print(f"pid={pid} +{elapsed // 60}m{elapsed % 60:02d}s waiting...")
        time.sleep(POLL_INTERVAL)


def main():
    parser = argparse.ArgumentParser(description="Run omni_tracer with vLLM-Omni")
    parser.add_argument(
        "model",
        choices=list(MODELS),
        help="Model to serve",
    )
    parser.add_argument(
        "--with-query",
        action="store_true",
        help="Send a default request to the model before terminating",
    )
    parser.add_argument(
        "--taint-notrace",
        action="append",
        default=None,
        help="Suppress tracing inside functions matching this qualname substring (repeatable)",
    )
    parser.add_argument(
        "--prefix",
        action="append",
        default=None,
        help="Scope prefix for tracing (repeatable; omit to auto-detect)",
    )
    args = parser.parse_args()

    model = MODELS[args.model]
    output = "traces/trace.db"
    track_file = "tracked.txt"
    os.makedirs(os.path.dirname(output), exist_ok=True)

    taint_args = []
    if args.taint_notrace:
        for pat in args.taint_notrace:
            taint_args.extend(["--taint-notrace", pat])

    prefix_args = []
    if args.prefix:
        for p in args.prefix:
            prefix_args.extend(["--prefix", p])

    cmd = [
        sys.executable, "-m", "tracer",
        "--output", output,
        "--tracked", track_file,
        *taint_args,
        *prefix_args,
        "--",
        "serve", args.model, "--omni",
        *model["args"],
    ]

    server = subprocess.Popen(cmd, start_new_session=True)

    try:
        if not poll_health(server.pid):
            os.killpg(server.pid, signal.SIGTERM)
            server.wait()
            sys.exit(1)

        if args.with_query:
            query = model.get("query")
            if not query:
                print(f"No default query defined for {args.model}", file=sys.stderr)
            else:
                print(f"Sending query to {query['url']}")
                data = json.dumps(query["body"]).encode()
                req = urllib.request.Request(
                    query["url"],
                    data=data,
                    headers={"Content-Type": "application/json"},
                )
                try:
                    resp = urllib.request.urlopen(req, timeout=120)
                    print(f"Query returned {resp.status}")
                except Exception as exc:
                    print(f"Query failed: {exc}", file=sys.stderr)

        print(f"Sending SIGTERM to pid {server.pid}")
        os.kill(server.pid, signal.SIGTERM)
        server.wait()
    except KeyboardInterrupt:
        os.kill(server.pid, signal.SIGTERM)
        server.wait()
        sys.exit(1)

    sys.exit(server.returncode or 0)


if __name__ == "__main__":
    main()
