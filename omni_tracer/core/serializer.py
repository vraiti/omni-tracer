from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from omni_tracer.analysis.ast_flow import get_function_flow_from_ref
from omni_tracer.analysis.dependency_graph import build_dependency_graph
from omni_tracer.analysis.value_flow import resolve_value_flows
from omni_tracer.core.graph import TraceGraph
from omni_tracer.core.node import FunctionNode


def serialize(
    graph: TraceGraph,
    output_path: str | Path,
) -> None:
    data = graph.to_dict()
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def resolve_and_enrich(trace_path: str | Path) -> None:
    path = Path(trace_path)
    with open(path) as f:
        data = json.load(f)

    functions = _load_functions(data.get("functions", {}))
    flows = _build_flows_from_refs(functions)
    value_edges = resolve_value_flows(functions, flows)

    data["value_flows"] = [e.to_dict() for e in value_edges]
    data["function_flows"] = {k: v.to_dict() for k, v in flows.items()}
    build_dependency_graph(data)

    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _load_functions(raw: dict[str, Any]) -> dict[str, FunctionNode]:
    functions: dict[str, FunctionNode] = {}
    for k, v in raw.items():
        functions[k] = FunctionNode(
            id=k,
            ref=v["ref"],
            process=v["process"],
            invokes=v.get("invokes", []),
            instantiates=v.get("instantiates", []),
            coroutine=v.get("coroutine"),
            bound_to=v.get("bound_to"),
            captured_args=v.get("captured_args"),
            timestamp=v.get("timestamp"),
            arg_ids=v.get("arg_ids"),
            arg_values=v.get("arg_values"),
            return_id=v.get("return_id"),
            return_value=v.get("return_value"),
        )
    return functions


def _build_flows_from_refs(functions: dict[str, FunctionNode]) -> dict:
    seen_refs: dict[str, Any] = {}
    flows = {}
    for func_id, node in functions.items():
        if node.ref in seen_refs:
            flow = seen_refs[node.ref]
        else:
            flow = get_function_flow_from_ref(node.ref)
            seen_refs[node.ref] = flow
        if flow is not None:
            flows[func_id] = flow
    return flows
