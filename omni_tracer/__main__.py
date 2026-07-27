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

    def stop_check(code: types.CodeType) -> bool:
        if (
            code.co_name == "omni_init_app_state"
            and "api_server" in code.co_filename
        ):
            _finalize()
            return True
        return False

    def _finalize() -> None:
        trace_hook.uninstall()
        thread_hook.uninstall()
        process_hook.drain_and_merge()
        process_hook.uninstall()
        serialize(graph, args.output)
        print(f"Trace written to {args.output}")

    def _signal_handler(signum: int, frame: types.FrameType | None) -> None:
        _finalize()
        sys.exit(0)

    trace_hook.set_stop_callback(stop_check)

    trace_hook.install()
    thread_hook.install()
    process_hook.install()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    sys.argv = passthrough
    from vllm_omni.entrypoints.cli.main import main as vllm_omni_main

    try:
        vllm_omni_main()
    except SystemExit:
        pass
    finally:
        if trace_hook.enabled:
            _finalize()


if __name__ == "__main__":
    main()
