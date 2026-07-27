from __future__ import annotations

import json
import multiprocessing
import multiprocessing.process
import os
import signal
import tempfile
import uuid
from typing import Any

from omni_tracer.core.graph import TraceGraph


_original_process_init = multiprocessing.process.BaseProcess.__init__


class ProcessHook:
    def __init__(self, output_dir: str, tracked_classes: list[str] | None = None) -> None:
        self.output_dir = output_dir
        self.tracked_classes = tracked_classes or []
        os.makedirs(output_dir, exist_ok=True)

    def install(self) -> None:
        hook = self

        def _patched_init(
            proc_self: multiprocessing.process.BaseProcess,
            group: Any = None,
            target: Any = None,
            name: Any = None,
            args: tuple = (),
            kwargs: dict | None = None,
            *,
            daemon: Any = None,
        ) -> None:
            if target is not None:
                process_uuid = str(uuid.uuid4())
                output_file = os.path.join(
                    hook.output_dir, f"{process_uuid}.json"
                )
                wrapped = _TracedTarget(
                    target, process_uuid, output_file, hook.tracked_classes
                )
                _original_process_init(
                    proc_self,
                    group=group,
                    target=wrapped,
                    name=name,
                    args=args,
                    kwargs=kwargs if kwargs is not None else {},
                    daemon=daemon,
                )
            else:
                _original_process_init(
                    proc_self,
                    group=group,
                    target=target,
                    name=name,
                    args=args,
                    kwargs=kwargs if kwargs is not None else {},
                    daemon=daemon,
                )

        multiprocessing.process.BaseProcess.__init__ = _patched_init

    def uninstall(self) -> None:
        multiprocessing.process.BaseProcess.__init__ = _original_process_init


class _TracedTarget:
    def __init__(
        self,
        original_target: Any,
        process_uuid: str,
        output_file: str,
        tracked_classes: list[str] | None = None,
    ) -> None:
        self.original_target = original_target
        self.process_uuid = process_uuid
        self.output_file = output_file
        self.tracked_classes = tracked_classes or []

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        from omni_tracer.core.graph import TraceGraph
        from omni_tracer.filters import PathFilter
        from omni_tracer.hooks.trace_hook import TraceHook

        local_graph = TraceGraph(process_uuid=self.process_uuid)
        path_filter = PathFilter()
        for cls_name in self.tracked_classes:
            path_filter.track_class(cls_name)
        trace_hook = TraceHook(local_graph, path_filter)

        def _sigterm_handler(signum, frame):
            trace_hook.uninstall()
            try:
                with open(self.output_file, "w") as f:
                    json.dump(local_graph.to_dict(), f)
            except Exception:
                pass
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, _sigterm_handler)

        trace_hook.install()
        try:
            return self.original_target(*args, **kwargs)
        finally:
            trace_hook.uninstall()
            try:
                with open(self.output_file, "w") as f:
                    json.dump(local_graph.to_dict(), f)
            except Exception:
                pass
