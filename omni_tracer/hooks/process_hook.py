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

_TRACE_OUTPUT_DIR = tempfile.mkdtemp(prefix="omni_tracer_")


class ProcessHook:
    def __init__(self, parent_graph: TraceGraph) -> None:
        self.parent_graph = parent_graph
        self._subprocess_files: list[str] = []
        self._tracked_processes: list[multiprocessing.process.BaseProcess] = []

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
                    _TRACE_OUTPUT_DIR, f"{process_uuid}.json"
                )
                hook._subprocess_files.append(output_file)
                hook._tracked_processes.append(proc_self)
                wrapped = _TracedTarget(
                    target, process_uuid, output_file
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
        for proc in self._tracked_processes:
            proc.join()

        for path in self._subprocess_files:
            if not os.path.exists(path):
                continue
            try:
                with open(path) as f:
                    data = json.load(f)
                sub_graph = TraceGraph.from_dict(data)
                self.parent_graph.merge(sub_graph)
            except Exception:
                pass
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass


class _TracedTarget:
    """Picklable callable that wraps a subprocess target with tracing."""

    def __init__(
        self,
        original_target: Any,
        process_uuid: str,
        output_file: str,
    ) -> None:
        self.original_target = original_target
        self.process_uuid = process_uuid
        self.output_file = output_file

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        from omni_tracer.core.graph import TraceGraph
        from omni_tracer.filters import PathFilter
        from omni_tracer.hooks.trace_hook import TraceHook

        local_graph = TraceGraph(process_uuid=self.process_uuid)
        path_filter = PathFilter()
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
