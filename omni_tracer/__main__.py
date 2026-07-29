from __future__ import annotations

import atexit
import multiprocessing
import os
import sys

from omni_tracer.cli import parse_args


def _parse_capture_spec(raw: str) -> dict:
    """Parse 'func_pattern:arg1.attr,arg2.attr2' into a serializable dict.

    Each comma-separated token is a dotted path: the first segment is
    the local variable name, the rest is the attribute path to resolve.
    Tokens are stored as-is in ``paths`` and converted to extraction
    entries by :class:`ArgCaptureSpec`.
    """
    if ":" not in raw:
        return {"func_pattern": raw, "paths": ["self"]}
    func_pattern, args_part = raw.split(":", 1)
    paths = [t.strip() for t in args_part.split(",") if t.strip()]
    return {"func_pattern": func_pattern, "paths": paths or ["self"]}


def _build_capture_specs(raw_specs: list[dict]) -> list:
    from omni_tracer.filters import ArgCaptureSpec
    return [ArgCaptureSpec(func_pattern=s["func_pattern"], paths=s["paths"]) for s in raw_specs]


def _traced_server(
    argv: list[str],
    output_file: str,
    tracked_classes: list[str] | None = None,
    capture_specs_raw: list[dict] | None = None,
    capture_only: bool = False,
    capture_value_flow: bool = False,
) -> None:
    from omni_tracer.core.graph import TraceGraph
    from omni_tracer.core.serializer import serialize
    from omni_tracer.filters import PathFilter
    from omni_tracer.hooks.process_hook import ProcessHook
    from omni_tracer.hooks.thread_hook import ThreadHook
    from omni_tracer.hooks.trace_hook import TraceHook

    capture_specs = _build_capture_specs(capture_specs_raw or [])

    output_dir = os.path.dirname(os.path.abspath(output_file))
    graph = TraceGraph()
    path_filter = PathFilter()
    for cls_name in (tracked_classes or []):
        path_filter.track_class(cls_name)
    trace_hook = TraceHook(graph, path_filter, capture_specs=capture_specs, capture_only=capture_only, capture_value_flow=capture_value_flow)
    thread_hook = ThreadHook(trace_hook._global_trace)
    process_hook = ProcessHook(output_dir, tracked_classes, capture_specs_raw=capture_specs_raw, capture_only=capture_only)

    _written = False

    def _write_trace() -> None:
        nonlocal _written
        if _written:
            return
        _written = True
        trace_hook.uninstall()
        thread_hook.uninstall()
        process_hook.uninstall()
        serialize(graph, output_file)
        print(f"Trace written to {output_file}")
        print(f"Subprocess traces written to {output_dir}/")

    atexit.register(_write_trace)

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

    capture_specs_raw = [_parse_capture_spec(s) for s in args.capture_args]

    proc = multiprocessing.Process(
        target=_traced_server,
        args=(passthrough, args.output, tracked, capture_specs_raw, args.capture_only, args.value_flow),
    )
    proc.start()
    proc.join()

    if args.value_flow and os.path.exists(args.output):
        from omni_tracer.core.serializer import resolve_and_enrich
        print(f"Resolving AST dataflow for {args.output}...")
        resolve_and_enrich(args.output)
        print("AST dataflow resolution complete.")

    sys.exit(proc.exitcode or 0)


if __name__ == "__main__":
    main()
