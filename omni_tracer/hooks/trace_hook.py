from __future__ import annotations

import inspect
import sys
import time
import types
from typing import Any

from omni_tracer.core.graph import TraceGraph
from omni_tracer.filters import ArgCaptureSpec, PathFilter
from omni_tracer.hooks.ownership import OwnershipHook

CO_COROUTINE = inspect.CO_COROUTINE


class TraceHook:
    def __init__(
        self,
        graph: TraceGraph,
        path_filter: PathFilter,
        capture_specs: list[ArgCaptureSpec] | None = None,
        capture_only: bool = False,
    ) -> None:
        self.graph = graph
        self.path_filter = path_filter
        self.ownership = OwnershipHook(graph, path_filter)
        self.enabled = True
        self._capture_specs = capture_specs or []
        self._capture_only = capture_only

    def install(self) -> None:
        self.ownership.install_module_hook()
        sys.settrace(self._global_trace)

    def uninstall(self) -> None:
        self.enabled = False
        sys.settrace(None)
        self.ownership.uninstall_module_hook()

    def _make_ref(self, code: types.CodeType) -> str:
        return f"{code.co_filename}:{code.co_qualname}"

    def _global_trace(
        self, frame: types.FrameType, event: str, arg: Any
    ) -> Any:
        if not self.enabled:
            return None

        if event != "call":
            return None

        try:
            return self._trace_call(frame)
        except Exception:
            return self._local_trace

    def _trace_call(self, frame: types.FrameType) -> Any:
        code = frame.f_code
        filename = code.co_filename

        if not self.path_filter.is_in_scope(filename):
            if code.co_name == "__init__":
                self_obj = frame.f_locals.get("self")
                if self_obj is not None and self.path_filter.is_tracked_class(type(self_obj)):
                    self._handle_init(frame, code, self_obj)
            return None

        captured_args = self._extract_args(frame, code) if self._capture_specs else None

        if self._capture_only and captured_args is None:
            if code.co_name == "__init__":
                self_obj = frame.f_locals.get("self")
                if self_obj is not None and self.path_filter.is_tracked_class(type(self_obj)):
                    self._handle_init(frame, code, self_obj)
            return None

        ref = self._make_ref(code)

        coroutine_uuid = None
        if code.co_flags & CO_COROUTINE:
            coroutine_uuid = self.graph.process_uuid + ":" + str(id(frame))

        bound_to = None
        self_obj = frame.f_locals.get("self")
        if self_obj is not None:
            bound_to = self.graph.get_object_uuid(id(self_obj))

        func_uuid = self.graph.record_call(
            ref,
            coroutine=coroutine_uuid,
            bound_to=bound_to,
            captured_args=captured_args,
            timestamp=time.time() if captured_args else None,
        )

        if code.co_name == "__init__":
            self._handle_init(frame, code, self_obj)

        return self._local_trace

    def _handle_init(
        self, frame: types.FrameType, code: types.CodeType,
        self_obj: Any,
    ) -> None:
        if self_obj is None:
            return
        cls = type(self_obj)
        cls_code = getattr(
            getattr(cls, "__init__", None), "__code__", None
        )
        if cls_code is not code:
            return
        tracked = self.path_filter.tracked_qualname(cls)
        if tracked:
            class_ref = tracked
        else:
            try:
                class_ref = f"{inspect.getfile(cls)}:{cls.__qualname__}"
            except (TypeError, OSError):
                class_ref = f"<unknown>:{cls.__qualname__}"
        creator_obj_uuid = self._find_creator(frame, self_obj)
        self.graph.record_instantiation(
            class_ref, id(self_obj), creator_obj_uuid=creator_obj_uuid
        )
        self.ownership.patch_class(cls)

    def _extract_args(
        self, frame: types.FrameType, code: types.CodeType,
    ) -> dict[str, str] | None:
        qualname = code.co_qualname
        for spec in self._capture_specs:
            if spec.func_pattern not in qualname:
                continue
            result: dict[str, str] = {}
            for path in spec.paths:
                parts = path.split(".")
                var_name = parts[0]
                val = frame.f_locals.get(var_name)
                if val is None:
                    continue
                for attr in parts[1:]:
                    val = getattr(val, attr, None)
                    if val is None:
                        break
                try:
                    result[path] = str(val)
                except Exception:
                    result[path] = repr(type(val))
            return result if result else None
        return None

    def _find_creator(
        self, frame: types.FrameType, self_obj: Any,
    ) -> str | None:
        f = frame.f_back
        while f is not None:
            caller_self = f.f_locals.get("self")
            if caller_self is not None and caller_self is not self_obj:
                uuid = self.graph.get_object_uuid(id(caller_self))
                if uuid is not None:
                    return uuid
            f = f.f_back
        return None

    def _local_trace(
        self, frame: types.FrameType, event: str, arg: Any
    ) -> Any:
        if not self.enabled:
            return None

        if event == "return":
            self.graph.record_return()
            return None

        return self._local_trace
