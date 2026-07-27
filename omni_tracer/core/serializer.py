from __future__ import annotations

import json
from pathlib import Path

from omni_tracer.core.graph import TraceGraph


def serialize(graph: TraceGraph, output_path: str | Path) -> None:
    data = graph.to_dict()
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
