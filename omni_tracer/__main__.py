from __future__ import annotations

import signal
import sys
import types

from omni_tracer.cli import parse_args
from omni_tracer.core.graph import TraceGraph
from omni_tracer.core.serializer import serialize
from omni_tracer.filters import PathFilter
from omni_tracer.hooks.process_hook import ProcessHook
from omni_tracer.hooks.thread_hook import ThreadHook
from omni_tracer.hooks.trace_hook import TraceHook


def main() -> None:
    args, passthrough = parse_args()

    graph = TraceGraph()
    path_filter = PathFilter()
    trace_hook = TraceHook(graph, path_filter)
    thread_hook = ThreadHook(trace_hook._global_trace)
    process_hook = ProcessHook(graph)
    finalized = False

    def _finalize() -> None:
        nonlocal finalized
        if finalized:
            return
        finalized = True
        trace_hook.uninstall()
        thread_hook.uninstall()
        process_hook.drain_and_merge()
        process_hook.uninstall()
        serialize(graph, args.output)
        print(f"Trace written to {args.output}")

    def _signal_handler(signum: int, frame: types.FrameType | None) -> None:
        _finalize()
        sys.exit(0)

    _install_stop_hook(_finalize)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    sys.argv = passthrough
    from vllm_omni.entrypoints.cli.main import main as vllm_omni_main

    trace_hook.install()
    thread_hook.install()
    process_hook.install()

    try:
        vllm_omni_main()
    except SystemExit:
        pass
    finally:
        _finalize()


def _install_stop_hook(finalize_cb: callable) -> None:
    import vllm_omni.entrypoints.openai.api_server as api_server

    _original = api_server.omni_init_app_state

    async def _patched(*args, **kwargs):
        finalize_cb()
        return await _original(*args, **kwargs)

    api_server.omni_init_app_state = _patched


if __name__ == "__main__":
    main()
