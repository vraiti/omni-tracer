from __future__ import annotations

import threading
from typing import Any


_original_thread_start = threading.Thread.start


class ThreadHook:
    def __init__(self, trace_func: Any) -> None:
        self._trace_func = trace_func

    def install(self) -> None:
        threading.settrace(self._trace_func)

        hook = self

        def _patched_start(thread_self: threading.Thread) -> None:
            _original_thread_start(thread_self)

        threading.Thread.start = _patched_start

    def uninstall(self) -> None:
        threading.settrace(None)
        threading.Thread.start = _original_thread_start
