from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from omni_tracer.analysis.ast_flow import (
    CallSite,
    FlowNodeKind,
    FunctionFlow,
)
from omni_tracer.core.node import FunctionNode


@dataclass
class ValueFlowEdge:
    source_func: str
    source_type: str
    source_name: str
    target_func: str
    target_type: str
    target_name: str
    obj_id: str | None = None
    value_repr: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "source_func": self.source_func,
            "source_type": self.source_type,
            "source_name": self.source_name,
            "target_func": self.target_func,
            "target_type": self.target_type,
            "target_name": self.target_name,
        }
        if self.obj_id is not None:
            d["obj_id"] = self.obj_id
        if self.value_repr is not None:
            d["value_repr"] = self.value_repr
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ValueFlowEdge:
        return cls(
            source_func=d["source_func"],
            source_type=d["source_type"],
            source_name=d["source_name"],
            target_func=d["target_func"],
            target_type=d["target_type"],
            target_name=d["target_name"],
            obj_id=d.get("obj_id"),
            value_repr=d.get("value_repr"),
        )


def resolve_value_flows(
    functions: dict[str, FunctionNode],
    flows: dict[str, FunctionFlow],
    obj_id_to_node_id: dict[int, str] | None = None,
) -> list[ValueFlowEdge]:
    edges: list[ValueFlowEdge] = []
    obj_lookup = obj_id_to_node_id or {}

    for parent_id, parent_node in functions.items():
        if not parent_node.invokes:
            continue
        parent_flow = flows.get(parent_id)

        for child_id in parent_node.invokes:
            child_node = functions.get(child_id)
            if child_node is None:
                continue

            edges.extend(_resolve_arg_flows(
                parent_id, parent_node, parent_flow,
                child_id, child_node,
                obj_lookup,
            ))
            edges.extend(_resolve_return_flows(
                parent_id, parent_flow,
                child_id, child_node,
                obj_lookup,
            ))

    return edges


def _resolve_arg_flows(
    parent_id: str,
    parent_node: FunctionNode,
    parent_flow: FunctionFlow | None,
    child_id: str,
    child_node: FunctionNode,
    obj_lookup: dict[int, str],
) -> list[ValueFlowEdge]:
    edges: list[ValueFlowEdge] = []
    child_arg_ids = child_node.arg_ids or {}
    child_arg_values = child_node.arg_values or {}

    if not child_arg_ids and not child_arg_values:
        return edges

    call_site = _find_call_site(parent_flow, child_node) if parent_flow else None

    param_names = list(child_arg_ids.keys()) or list(child_arg_values.keys())
    for i, param_name in enumerate(param_names):
        arg_id = child_arg_ids.get(param_name)
        arg_repr = child_arg_values.get(param_name)
        obj_node_id = obj_lookup.get(arg_id) if arg_id else None

        source_name = ""
        if call_site:
            if i < len(call_site.arg_exprs):
                source_name = call_site.arg_exprs[i]
            elif param_name in call_site.kwarg_exprs:
                source_name = call_site.kwarg_exprs[param_name]

        edges.append(ValueFlowEdge(
            source_func=parent_id,
            source_type="arg",
            source_name=source_name,
            target_func=child_id,
            target_type="arg",
            target_name=param_name,
            obj_id=obj_node_id,
            value_repr=arg_repr,
        ))

    return edges


def _resolve_return_flows(
    parent_id: str,
    parent_flow: FunctionFlow | None,
    child_id: str,
    child_node: FunctionNode,
    obj_lookup: dict[int, str],
) -> list[ValueFlowEdge]:
    edges: list[ValueFlowEdge] = []
    if child_node.return_id is None and child_node.return_value is None:
        return edges

    obj_node_id = obj_lookup.get(child_node.return_id) if child_node.return_id else None

    target_name = ""
    if parent_flow:
        target_name = _find_return_target(parent_flow, child_node)

    edges.append(ValueFlowEdge(
        source_func=child_id,
        source_type="return",
        source_name="",
        target_func=parent_id,
        target_type="return",
        target_name=target_name,
        obj_id=obj_node_id,
        value_repr=child_node.return_value,
    ))

    return edges


def _find_call_site(
    parent_flow: FunctionFlow, child_node: FunctionNode,
) -> CallSite | None:
    child_qualname = child_node.ref.split(":")[-1] if ":" in child_node.ref else child_node.ref
    parts = child_qualname.rsplit(".", 1)
    method_name = parts[-1] if parts else child_qualname

    for site in parent_flow.call_sites:
        if site.func_expr.endswith(method_name):
            return site
    return None


def _find_return_target(flow: FunctionFlow, child_node: FunctionNode) -> str:
    child_qualname = child_node.ref.split(":")[-1] if ":" in child_node.ref else child_node.ref
    parts = child_qualname.rsplit(".", 1)
    method_name = parts[-1] if parts else child_qualname

    for edge in flow.edges:
        if (
            edge.source.kind == FlowNodeKind.CALL_RESULT
            and edge.source.func_expr.endswith(method_name)
            and edge.sink.kind == FlowNodeKind.LOCAL
        ):
            return edge.sink.name
    return ""
