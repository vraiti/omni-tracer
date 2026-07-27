from __future__ import annotations

import argparse
import sys


def parse_args() -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(
        prog="omni_tracer",
        description="Trace vLLM-Omni initialization and output a JSON graph",
    )
    parser.add_argument(
        "--output",
        "-o",
        default="trace.json",
        help="Output JSON file path (default: trace.json)",
    )
    parser.add_argument(
        "--track",
        action="append",
        default=[],
        help="External class to track (e.g. fastapi.FastAPI). May be repeated.",
    )
    parser.add_argument(
        "--track-file",
        default=None,
        help="File listing external classes to track, one per line.",
    )
    try:
        sep = sys.argv.index("--")
        tracer_args = sys.argv[1:sep]
        passthrough_args = sys.argv[sep + 1 :]
    except ValueError:
        tracer_args = sys.argv[1:]
        passthrough_args = []

    ns = parser.parse_args(tracer_args)
    return ns, passthrough_args
