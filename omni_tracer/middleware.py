from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Any

from omni_tracer.core.graph import TraceGraph
from omni_tracer.core.serializer import serialize
from omni_tracer.filters import PathFilter
from omni_tracer.hooks.trace_hook import TraceHook

TRACE_HEADER = "x-trace"
TRACE_DIR = "/tmp/omni_traces"


def wrap_app_with_tracing(
    app: Any,
    path_filter: PathFilter,
    registry: TraceGraph | None = None,
) -> None:
    os.makedirs(TRACE_DIR, exist_ok=True)
    original_call = app.__class__.__call__

    async def _traced_call(self, scope, receive, send):
        if scope["type"] != "http":
            return await original_call(self, scope, receive, send)

        headers = dict(scope.get("headers", []))
        if headers.get(TRACE_HEADER.encode(), b"").lower() != b"true":
            return await original_call(self, scope, receive, send)

        graph = TraceGraph(registry=registry)
        hook = TraceHook(graph, path_filter)

        trace_id = str(uuid.uuid4())[:8]
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"trace-{timestamp}-{trace_id}.json"
        output_path = os.path.join(TRACE_DIR, filename)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append(
                    (b"x-trace-file", output_path.encode())
                )
                headers.append(
                    (
                        b"x-trace-functions",
                        str(len(graph.functions)).encode(),
                    )
                )
                headers.append(
                    (
                        b"x-trace-objects",
                        str(len(graph.objects)).encode(),
                    )
                )
                message = {**message, "headers": headers}
            await send(message)

        hook.install()
        try:
            await original_call(self, scope, receive, send_with_headers)
        finally:
            hook.uninstall()
            serialize(graph, output_path)

    app.__class__.__call__ = _traced_call
