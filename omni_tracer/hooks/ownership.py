from __future__ import annotations

import inspect
from typing import Any

from omni_tracer.core.graph import TraceGraph
from omni_tracer.filters import PathFilter


class OwnershipHook:
    def __init__(self, graph: TraceGraph, path_filter: PathFilter) -> None:
        self.graph = graph
        self.path_filter = path_filter
        self._patched_classes: set[int] = set()

    def patch_class(self, cls: type) -> None:
        cls_id = id(cls)
        if cls_id in self._patched_classes:
            return

        try:
            source_file = inspect.getfile(cls)
        except (TypeError, OSError):
            return

        if not self.path_filter.is_in_scope(source_file) and not self.path_filter.is_tracked_class(cls):
            return

        self._patched_classes.add(cls_id)

        original_setattr = cls.__setattr__
        graph = self.graph

        def _traced_setattr(self_obj: Any, name: str, value: Any) -> None:
            original_setattr(self_obj, name, value)
            owned_uuid = graph.get_object_uuid(id(value))
            if owned_uuid is not None:
                graph.record_ownership(id(self_obj), id(value), name)

        try:
            cls.__setattr__ = _traced_setattr
        except TypeError:
            pass
