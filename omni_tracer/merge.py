"""Merge multiple trace JSON files into one."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from omni_tracer.core.graph import TraceGraph
from omni_tracer.core.serializer import serialize


def merge_traces(paths: list[str | Path], output: str | Path) -> TraceGraph:
    combined = TraceGraph()
    for path in paths:
        with open(path) as f:
            data = json.load(f)
        sub = TraceGraph.from_dict(data)
        combined.merge(sub)
    serialize(combined, output)
    return combined


def main() -> None:
    if len(sys.argv) < 3:
        print(f"Usage: python -m omni_tracer.merge <output> <trace1> [trace2 ...]")
        sys.exit(1)
    output = sys.argv[1]
    inputs = sys.argv[2:]
    graph = merge_traces(inputs, output)
    procs = set()
    for v in graph.functions.values():
        procs.add(v.process)
    for v in graph.objects.values():
        procs.add(v.process)
    print(
        f"Merged {len(inputs)} traces: "
        f"{len(graph.functions)} functions, "
        f"{len(graph.objects)} objects, "
        f"{len(procs)} processes -> {output}"
    )


if __name__ == "__main__":
    main()
