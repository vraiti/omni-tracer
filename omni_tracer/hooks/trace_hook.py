from __future__ import annotations

import inspect
import sys
import types
from typing import Any

from omni_tracer.core.graph import TraceGraph
from omni_tracer.filters import PathFilter
from omni_tracer.hooks.ownership import OwnershipHook

CO_COROUTINE = inspect.CO_COROUTINE


class TraceHook:
    def __init__(self, graph: TraceGraph, path_filter: PathFilter) -> None:
        self.graph = graph
        self.path_filter = path_filter
        self.ownership = OwnershipHook(graph, path_filter)
        self.enabled = True
        self._stop_callback: callable | None = None

    def set_stop_callback(self, cb: callable) -> None:
        self._stop_callback = cb

    def install(self) -> None:
        sys.settrace(self._global_trace)

    def uninstall(self) -> None:
        self.enabled = False
        sys.settrace(None)

    def _make_ref(self, code: types.CodeType) -> str:
        return f"{code.co_filename}:{code.co_qualname}"

    def _global_trace(
        self, frame: types.FrameType, event: str, arg: Any
    ) -> Any:
        if not self.enabled:
            return None

        if event != "call":
            return None

        code = frame.f_code
        filename = code.co_filename

        if not self.path_filter.is_in_scope(filename):
            return None

        if self._stop_callback and self._stop_callback(code):
            return None

        ref = self._make_ref(code)

        coroutine_uuid = None
        if code.co_flags & CO_COROUTINE:
            coroutine_uuid = self.graph.process_uuid + ":" + str(id(frame))

        func_uuid = self.graph.record_call(ref, coroutine=coroutine_uuid)

        if code.co_name == "__init__":
            self_obj = frame.f_locals.get("self")
            if self_obj is not None:
                cls = type(self_obj)
                cls_code = getattr(
                    getattr(cls, "__init__", None), "__code__", None
                )
                if cls_code is code:
                    class_ref = (
                        f"{inspect.getfile(cls)}:{cls.__qualname__}"
                    )
                    caller_uuid = None
                    stack = self.graph._call_stack()
                    if len(stack) >= 2:
                        caller_uuid = stack[-2]
                    self.graph.record_instantiation(
                        class_ref, id(self_obj), caller_uuid
                    )
                    self.ownership.patch_class(cls)

        return self._local_trace

    def _local_trace(
        self, frame: types.FrameType, event: str, arg: Any
    ) -> Any:
        if not self.enabled:
            return None

        if event == "return":
            self.graph.record_return()
            return None

        return self._local_trace
