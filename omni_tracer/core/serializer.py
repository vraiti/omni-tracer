from __future__ import annotations

import json
from pathlib import Path

from omni_tracer.analysis.ast_flow import get_function_flow
from omni_tracer.analysis.value_flow import resolve_value_flows
from omni_tracer.core.graph import TraceGraph


def serialize(
    graph: TraceGraph,
    output_path: str | Path,
    resolve_flows: bool = True,
) -> None:
    data = graph.to_dict()
    if resolve_flows:
        flow_data = _build_value_flows(graph)
        data["value_flows"] = flow_data["edges"]
        data["function_flows"] = flow_data["flows"]
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _build_value_flows(graph: TraceGraph) -> dict:
    flows = {}
    for uuid, node in graph.functions.items():
        code_obj = _find_code_object(node.ref)
        if code_obj is not None:
            flow = get_function_flow(code_obj, node.ref)
            if flow is not None:
                flows[uuid] = flow

    value_edges = resolve_value_flows(
        graph.functions, flows, graph._obj_id_to_uuid,
    )
    return {
        "edges": [e.to_dict() for e in value_edges],
        "flows": {k: v.to_dict() for k, v in flows.items()},
    }


def _find_code_object(ref: str):
    parts = ref.split(":")
    if len(parts) != 2:
        return None
    qualname = parts[1]
    import sys
    for mod in list(sys.modules.values()):
        if mod is None:
            continue
        obj = _resolve_qualname(mod, qualname)
        if obj is not None:
            try:
                code = getattr(obj, "__code__", None)
            except Exception:
                continue
            if code is not None:
                return code
    return None


def _resolve_qualname(mod, qualname: str):
    parts = qualname.split(".")
    obj = mod
    for part in parts:
        try:
            obj = getattr(obj, part, None)
        except Exception:
            return None
        if obj is None:
            return None
    return obj
