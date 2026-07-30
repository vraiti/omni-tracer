from __future__ import annotations

import atexit
import multiprocessing
import multiprocessing.process
import os
import sys
from typing import Any


_original_process_init = multiprocessing.process.BaseProcess.__init__


class ProcessHook:
    def __init__(
        self,
        output_dir: str,
        prefixes: list[str],
        tracked_file: str | None = None,
        taint_patterns: list[str] | None = None,
        no_postprocess: bool = False,
    ) -> None:
        self.output_dir = output_dir
        self.prefixes = prefixes
        self.tracked_file = tracked_file
        self.taint_patterns = taint_patterns
        self.no_postprocess = no_postprocess
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
                wrapped = _TracedTarget(
                    target,
                    hook.output_dir,
                    hook.prefixes,
                    tracked_file=hook.tracked_file,
                    taint_patterns=hook.taint_patterns,
                    no_postprocess=hook.no_postprocess,
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
        output_dir: str,
        prefixes: list[str],
        tracked_file: str | None = None,
        taint_patterns: list[str] | None = None,
        no_postprocess: bool = False,
    ) -> None:
        self.original_target = original_target
        self.output_dir = output_dir
        self.prefixes = prefixes
        self.tracked_file = tracked_file
        self.taint_patterns = taint_patterns
        self.no_postprocess = no_postprocess

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        import threading

        from tracer._tracer import (
            Database,
            OwnershipHook,
            PathFilter,
            install,
            install_thread,
            uninstall,
        )
        from tracer.ast_index import AstIndex
        from tracer.ipc import patch_message_queue
        from tracer.postprocess import postprocess

        pid = os.getpid()
        output_file = os.path.join(self.output_dir, f"{pid}.db")

        path_filter = PathFilter(prefixes=self.prefixes, tracked_file=self.tracked_file)
        ast_index = AstIndex()
        ast_index.preprocess(path_filter)

        db = Database()

        from tracer.__main__ import TraceHook
        hook = TraceHook(db, ast_index, path_filter)
        ownership = OwnershipHook(db, hook)
        hook.set_ownership_hook(ownership)

        patch_message_queue(db)

        prefixes = list(path_filter._prefixes)
        install(hook, prefixes, taint_patterns=self.taint_patterns)

        _original_run = threading.Thread.run
        def _patched_run(self_thread: threading.Thread) -> None:
            install_thread()
            _original_run(self_thread)
        threading.Thread.run = _patched_run  # type: ignore

        def _write_trace() -> None:
            uninstall()
            try:
                from tracer.__main__ import serialize
                serialize(db, ast_index, output_file)
                if not self.no_postprocess:
                    postprocess(output_file)
            except Exception:
                import traceback
                traceback.print_exc()

        atexit.register(_write_trace)

        try:
            return self.original_target(*args, **kwargs)
        finally:
            _write_trace()
