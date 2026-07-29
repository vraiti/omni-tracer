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
    args = parser.parse_args()

    model = MODELS[args.model]
    output = "traces/trace.json"
    track_file = "tracked.txt"
    os.makedirs(os.path.dirname(output), exist_ok=True)

    cmd = [
        sys.executable, "-m", "omni_tracer",
        "-o", output,
        "--track-file", track_file,
        "--capture-args", "SpinCondition.__init__:notify_address",
        "--value-flow",
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

        print(f"Sending SIGTERM to process group (pgid {server.pid})")
        os.killpg(server.pid, signal.SIGTERM)
        server.wait()
    except KeyboardInterrupt:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait()
        sys.exit(1)

    sys.exit(server.returncode or 0)


if __name__ == "__main__":
    main()
