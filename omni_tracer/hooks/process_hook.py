from __future__ import annotations

import multiprocessing
import multiprocessing.process
import uuid
from typing import Any

from omni_tracer.core.graph import TraceGraph


_original_process_init = multiprocessing.process.BaseProcess.__init__


class ProcessHook:
    def __init__(self, parent_graph: TraceGraph) -> None:
        self.parent_graph = parent_graph
        self.data_queue: multiprocessing.Queue = multiprocessing.Queue()

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
                wrapped = _wrap_target(
                    target, process_uuid, hook.data_queue
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

    def drain_and_merge(self) -> None:
        while not self.data_queue.empty():
            try:
                subprocess_data = self.data_queue.get_nowait()
                sub_graph = TraceGraph.from_dict(subprocess_data)
                self.parent_graph.merge(sub_graph)
            except Exception:
                break


def _wrap_target(
    original_target: Any,
    process_uuid: str,
    data_queue: multiprocessing.Queue,
) -> Any:
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        from omni_tracer.core.graph import TraceGraph
        from omni_tracer.filters import PathFilter
        from omni_tracer.hooks.trace_hook import TraceHook

        local_graph = TraceGraph(process_uuid=process_uuid)
        path_filter = PathFilter()
        trace_hook = TraceHook(local_graph, path_filter)
        trace_hook.install()
        try:
            return original_target(*args, **kwargs)
        finally:
            trace_hook.uninstall()
            try:
                data_queue.put(local_graph.to_dict())
            except Exception:
                pass

    return wrapper
