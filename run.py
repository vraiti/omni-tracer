#!/usr/bin/env python3
import argparse
import os
import signal
import subprocess
import sys

MODELS = {
    "Tongyi-MAI/Z-Image-Turbo": {
        "args": [],
    },
    "Qwen/Qwen3-Omni-30B-A3B-Instruct": {
        "args": ["--quantization", "fp8"],
    },
}

POLL_SCRIPT = "vllm-omni-aux/utils/poll-server-health.sh"
HOST = "localhost:8000"


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
        poll = subprocess.run(
            [POLL_SCRIPT, str(server.pid), HOST],
            check=False,
        )
        if poll.returncode != 0:
            print("Server failed to become ready", file=sys.stderr)
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
