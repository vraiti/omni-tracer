from __future__ import annotations

import multiprocessing
import os
import signal
import sys

from omni_tracer.cli import parse_args


def _traced_server(argv: list[str], output_file: str, tracked_classes: list[str] | None = None) -> None:
    from omni_tracer.core.graph import TraceGraph
    from omni_tracer.core.serializer import serialize
    from omni_tracer.filters import PathFilter
    from omni_tracer.hooks.process_hook import ProcessHook
    from omni_tracer.hooks.thread_hook import ThreadHook
    from omni_tracer.hooks.trace_hook import TraceHook

    output_dir = os.path.dirname(os.path.abspath(output_file))
    graph = TraceGraph()
    path_filter = PathFilter()
    for cls_name in (tracked_classes or []):
        path_filter.track_class(cls_name)
    trace_hook = TraceHook(graph, path_filter)
    thread_hook = ThreadHook(trace_hook._global_trace)
    process_hook = ProcessHook(output_dir, tracked_classes)

    def _write_trace() -> None:
        trace_hook.uninstall()
        thread_hook.uninstall()
        process_hook.uninstall()
        serialize(graph, output_file)
        print(f"Trace written to {output_file}")
        print(f"Subprocess traces written to {output_dir}/")

    def _sigterm_handler(signum, frame):
        _write_trace()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _sigterm_handler)

    trace_hook.install()
    thread_hook.install()
    process_hook.install()

    sys.argv = ["vllm"] + list(argv)
    from vllm.entrypoints.cli.main import main as vllm_main

    try:
        vllm_main()
    except SystemExit:
        pass
    finally:
        _write_trace()


def main() -> None:
    args, passthrough = parse_args()

    tracked = list(args.track)
    if args.track_file:
        with open(args.track_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    tracked.append(line)

    proc = multiprocessing.Process(
        target=_traced_server,
        args=(passthrough, args.output, tracked),
    )
    proc.start()
    proc.join()
    sys.exit(proc.exitcode or 0)


if __name__ == "__main__":
    main()
