from __future__ import annotations

import os
import uuid
from datetime import datetime

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from omni_tracer.core.graph import TraceGraph
from omni_tracer.core.serializer import serialize
from omni_tracer.filters import PathFilter
from omni_tracer.hooks.trace_hook import TraceHook

TRACE_HEADER = "X-Trace"
TRACE_DIR = "/tmp/omni_traces"


class TraceMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, path_filter: PathFilter | None = None):
        super().__init__(app)
        self.path_filter = path_filter or PathFilter()
        os.makedirs(TRACE_DIR, exist_ok=True)

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.headers.get(TRACE_HEADER, "").lower() != "true":
            return await call_next(request)

        graph = TraceGraph()
        hook = TraceHook(graph, self.path_filter)
        hook.install()
        try:
            response = await call_next(request)
        finally:
            hook.uninstall()
            trace_id = str(uuid.uuid4())[:8]
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"trace-{timestamp}-{trace_id}.json"
            output_path = os.path.join(TRACE_DIR, filename)
            serialize(graph, output_path)

        response.headers["X-Trace-File"] = output_path
        response.headers["X-Trace-Functions"] = str(len(graph.functions))
        response.headers["X-Trace-Objects"] = str(len(graph.objects))
        return response
