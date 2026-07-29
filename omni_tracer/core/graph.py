from __future__ import annotations

import itertools
import os
import threading
from typing import Any

from omni_tracer.core.node import FunctionNode, ObjectNode


class TraceGraph:
    def __init__(
        self,
        process_id: str | None = None,
        registry: TraceGraph | None = None,
    ) -> None:
        self.process_id = process_id or str(os.getpid())
        self.functions: dict[str, FunctionNode] = {}
        self.objects: dict[str, ObjectNode] = {}
        self._lock = threading.Lock()
        self._local = threading.local()
        self._obj_id_to_node_id: dict[int, str] = {}
        self._registry = registry
        self._id_counter = itertools.count()
        self.queue_events: list[dict] = []

    def _next_id(self) -> str:
        return f"{self.process_id}-{next(self._id_counter)}"

    def _call_stack(self) -> list[str]:
        stack = getattr(self._local, "call_stack", None)
        if stack is None:
            stack = []
            self._local.call_stack = stack
        return stack

    def record_call(
        self,
        ref: str,
        coroutine: str | None = None,
        bound_to: str | None = None,
        captured_args: dict[str, str] | None = None,
        timestamp: float | None = None,
        arg_ids: dict[str, int] | None = None,
        arg_values: dict[str, str] | None = None,
    ) -> str:
        node = FunctionNode(
            ref=ref,
            process=self.process_id,
            id=self._next_id(),
            coroutine=coroutine,
            bound_to=bound_to,
            captured_args=captured_args,
            timestamp=timestamp,
            arg_ids=arg_ids,
            arg_values=arg_values,
        )
        stack = self._call_stack()
        with self._lock:
            self.functions[node.id] = node
            if stack:
                parent = self.functions.get(stack[-1])
                if parent:
                    parent.invokes.append(node.id)
        stack.append(node.id)
        return node.id

    def record_return(
        self,
        return_id: int | None = None,
        return_value: str | None = None,
    ) -> str | None:
        stack = self._call_stack()
        if stack:
            node_id = stack.pop()
            if return_id is not None or return_value is not None:
                with self._lock:
                    node = self.functions.get(node_id)
                    if node is not None:
                        node.return_id = return_id
                        node.return_value = return_value
            return node_id
        return None

    def record_instantiation(
        self, ref: str, obj_id: int,
        creator_id: str | None = None,
        created_in: str | None = None,
    ) -> str:
        existing = self._resolve_object_id(obj_id)
        if existing is not None:
            with self._lock:
                self._obj_id_to_node_id[obj_id] = existing
            return existing
        node = ObjectNode(ref=ref, process=self.process_id, id=self._next_id(), created_by=creator_id, created_in=created_in)
        with self._lock:
            self.objects[node.id] = node
            self._obj_id_to_node_id[obj_id] = node.id
        return node.id

    def record_ownership(self, owner_id: int, owned_id: int, attr_name: str = "") -> bool:
        with self._lock:
            owner_node_id = self._resolve_object_id(owner_id)
            owned_node_id = self._resolve_object_id(owned_id)
            if owner_node_id and owned_node_id and owner_node_id != owned_node_id:
                owner_node = self.objects.get(owner_node_id)
                if owner_node and owned_node_id not in owner_node.owns:
                    owner_node.owns[owned_node_id] = attr_name
                    return True
        return False

    def record_attr(self, obj_id: int, name: str, value_repr: str) -> None:
        with self._lock:
            node_id = self._resolve_object_id(obj_id)
            if node_id is None:
                return
            node = self.objects.get(node_id)
            if node is not None:
                node.attrs[name] = value_repr

    def get_object_id(self, obj_id: int) -> str | None:
        with self._lock:
            return self._resolve_object_id(obj_id)

    def _resolve_object_id(self, obj_id: int) -> str | None:
        node_id = self._obj_id_to_node_id.get(obj_id)
        if node_id is not None:
            return node_id
        if self._registry is not None:
            return self._registry.get_object_id(obj_id)
        return None

    def record_queue_event(
        self,
        queue_id: str,
        direction: str,
        item_id: str,
        item_repr: str,
    ) -> None:
        caller = self.current_caller()
        with self._lock:
            self.queue_events.append({
                "id": item_id,
                "queue_id": queue_id,
                "direction": direction,
                "item_repr": item_repr,
                "caller": caller,
            })

    def current_caller(self) -> str | None:
        stack = self._call_stack()
        return stack[-1] if stack else None

    def merge(self, other: TraceGraph) -> None:
        with self._lock:
            self.functions.update(other.functions)
            self.objects.update(other.objects)
            self._obj_id_to_node_id.update(other._obj_id_to_node_id)
            self.queue_events.extend(other.queue_events)

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "process_id": self.process_id,
                "functions": {
                    k: v.to_dict() for k, v in self.functions.items()
                },
                "objects": {
                    k: v.to_dict() for k, v in self.objects.items()
                },
                "queue_events": list(self.queue_events),
            }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TraceGraph:
        graph = cls(process_id=data.get("process_id", ""))
        for k, v in data.get("functions", {}).items():
            node = FunctionNode(
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
            graph.functions[k] = node
        for k, v in data.get("objects", {}).items():
            raw_owns = v.get("owns", {})
            if isinstance(raw_owns, list):
                raw_owns = {u: "" for u in raw_owns}
            node = ObjectNode(
                id=k,
                ref=v["ref"],
                process=v["process"],
                owns=raw_owns,
                created_by=v.get("created_by"),
                created_in=v.get("created_in"),
                attrs=v.get("attrs", {}),
            )
            graph.objects[k] = node
        return graph
