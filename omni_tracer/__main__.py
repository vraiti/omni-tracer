from __future__ import annotations

import os
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

    output_dir = os.path.dirname(os.path.abspath(args.output))
    graph = TraceGraph()
    path_filter = PathFilter()
    trace_hook = TraceHook(graph, path_filter)
    thread_hook = ThreadHook(trace_hook._global_trace)
    process_hook = ProcessHook(output_dir)
    finalized = False

    def _finalize() -> None:
        nonlocal finalized
        if finalized:
            return
        finalized = True
        trace_hook.uninstall()
        thread_hook.uninstall()
        process_hook.uninstall()
        serialize(graph, args.output)
        print(f"Trace written to {args.output}")
        print(f"Subprocess traces written to {output_dir}/")

    _install_hooks(_finalize, path_filter, graph)

    signal.signal(signal.SIGINT, lambda s, f: (_finalize(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda s, f: (_finalize(), sys.exit(0)))

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


def _install_hooks(
    finalize_cb: callable,
    path_filter: PathFilter,
    init_graph: TraceGraph,
) -> None:
    import vllm_omni.entrypoints.openai.api_server as omni_api

    _original_init = omni_api.omni_init_app_state
    _original_build = omni_api.build_openai_app

    def _patched_build(*args, **kwargs):
        from omni_tracer.middleware import wrap_app_with_tracing
        app = _original_build(*args, **kwargs)
        wrap_app_with_tracing(app, path_filter, registry=init_graph)
        print(
            "Trace middleware installed"
            " (send X-Trace: true header to trace a request)"
        )
        return app

    omni_api.build_openai_app = _patched_build

    async def _patched_init(*args, **kwargs):
        finalize_cb()
        return await _original_init(*args, **kwargs)

    omni_api.omni_init_app_state = _patched_init


if __name__ == "__main__":
    main()
