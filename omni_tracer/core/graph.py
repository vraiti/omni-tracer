from __future__ import annotations

import threading
import uuid
from typing import Any

from omni_tracer.core.node import FunctionNode, ObjectNode


class TraceGraph:
    def __init__(
        self,
        process_uuid: str | None = None,
        registry: TraceGraph | None = None,
    ) -> None:
        self.process_uuid = process_uuid or str(uuid.uuid4())
        self.functions: dict[str, FunctionNode] = {}
        self.objects: dict[str, ObjectNode] = {}
        self._lock = threading.Lock()
        self._local = threading.local()
        self._obj_id_to_uuid: dict[int, str] = {}
        self._registry = registry

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
    ) -> str:
        node = FunctionNode(
            ref=ref,
            process=self.process_uuid,
            coroutine=coroutine,
            bound_to=bound_to,
        )
        stack = self._call_stack()
        with self._lock:
            self.functions[node.uuid] = node
            if stack:
                parent = self.functions.get(stack[-1])
                if parent:
                    parent.invokes.append(node.uuid)
        stack.append(node.uuid)
        return node.uuid

    def record_return(self) -> str | None:
        stack = self._call_stack()
        if stack:
            return stack.pop()
        return None

    def record_instantiation(
        self, ref: str, obj_id: int, caller_uuid: str | None = None
    ) -> str:
        existing = self._resolve_object_uuid(obj_id)
        if existing is not None:
            with self._lock:
                self._obj_id_to_uuid[obj_id] = existing
                if caller_uuid:
                    parent = self.functions.get(caller_uuid)
                    if parent:
                        parent.instantiates.append(existing)
            return existing
        node = ObjectNode(ref=ref, process=self.process_uuid)
        with self._lock:
            self.objects[node.uuid] = node
            self._obj_id_to_uuid[obj_id] = node.uuid
            if caller_uuid:
                parent = self.functions.get(caller_uuid)
                if parent:
                    parent.instantiates.append(node.uuid)
        return node.uuid

    def record_ownership(self, owner_id: int, owned_id: int, attr_name: str = "") -> bool:
        with self._lock:
            owner_uuid = self._resolve_object_uuid(owner_id)
            owned_uuid = self._resolve_object_uuid(owned_id)
            if owner_uuid and owned_uuid and owner_uuid != owned_uuid:
                owner_node = self.objects.get(owner_uuid)
                if owner_node and owned_uuid not in owner_node.owns:
                    owner_node.owns[owned_uuid] = attr_name
                    return True
        return False

    def get_object_uuid(self, obj_id: int) -> str | None:
        with self._lock:
            return self._resolve_object_uuid(obj_id)

    def _resolve_object_uuid(self, obj_id: int) -> str | None:
        uuid = self._obj_id_to_uuid.get(obj_id)
        if uuid is not None:
            return uuid
        if self._registry is not None:
            return self._registry.get_object_uuid(obj_id)
        return None

    def current_caller(self) -> str | None:
        stack = self._call_stack()
        return stack[-1] if stack else None

    def merge(self, other: TraceGraph) -> None:
        with self._lock:
            self.functions.update(other.functions)
            self.objects.update(other.objects)
            self._obj_id_to_uuid.update(other._obj_id_to_uuid)

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "process_uuid": self.process_uuid,
                "functions": {
                    k: v.to_dict() for k, v in self.functions.items()
                },
                "objects": {
                    k: v.to_dict() for k, v in self.objects.items()
                },
            }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TraceGraph:
        graph = cls(process_uuid=data.get("process_uuid", ""))
        for k, v in data.get("functions", {}).items():
            node = FunctionNode(
                uuid=k,
                ref=v["ref"],
                process=v["process"],
                invokes=v.get("invokes", []),
                instantiates=v.get("instantiates", []),
                coroutine=v.get("coroutine"),
                bound_to=v.get("bound_to"),
            )
            graph.functions[k] = node
        for k, v in data.get("objects", {}).items():
            raw_owns = v.get("owns", {})
            if isinstance(raw_owns, list):
                raw_owns = {u: "" for u in raw_owns}
            node = ObjectNode(
                uuid=k,
                ref=v["ref"],
                process=v["process"],
                owns=raw_owns,
            )
            graph.objects[k] = node
        return graph
