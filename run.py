#!/usr/bin/env python3
import argparse
import os
import signal
import subprocess
import sys
import time
import urllib.request

MODELS = {
    "Tongyi-MAI/Z-Image-Turbo": {
        "args": [],
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
    args = parser.parse_args()

    model = MODELS[args.model]
    output = "traces/trace.json"
    track_file = "tracked.txt"
    os.makedirs(os.path.dirname(output), exist_ok=True)

    cmd = [
        sys.executable, "-m", "omni_tracer",
        "-o", output,
        "--track-file", track_file,
        "--",
        "serve", args.model, "--omni",
        *model["args"],
    ]

    server = subprocess.Popen(cmd)

    try:
        if not poll_health(server.pid):
            server.terminate()
            server.wait()
            sys.exit(1)

        print(f"Sending SIGTERM to server (pid {server.pid})")
        server.send_signal(signal.SIGTERM)
        server.wait()
    except KeyboardInterrupt:
        server.terminate()
        server.wait()
        sys.exit(1)

    sys.exit(server.returncode or 0)


if __name__ == "__main__":
    main()
