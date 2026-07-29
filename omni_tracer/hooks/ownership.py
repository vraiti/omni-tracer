from __future__ import annotations

import inspect
import itertools
from typing import Any

from omni_tracer.core.graph import TraceGraph
from omni_tracer.filters import PathFilter

_PRIMITIVE_TYPES = (str, int, float, bool, type(None))


def _safe_repr(obj: object) -> str:
    if isinstance(obj, _PRIMITIVE_TYPES):
        return repr(obj)
    return f"<{type(obj).__qualname__}>"


class OwnershipHook:
    def __init__(self, graph: TraceGraph, path_filter: PathFilter) -> None:
        self.graph = graph
        self.path_filter = path_filter
        self._patched_classes: set[int] = set()
        self._module_hook_handle = None

    def install_module_hook(self) -> None:
        from torch.nn.modules.module import register_module_module_registration_hook

        graph = self.graph
        path_filter = self.path_filter

        def _on_register(parent: Any, name: str, child: Any) -> None:
            child_id = graph.get_object_id(id(child))
            if child_id is None:
                return
            parent_id = graph.get_object_id(id(parent))
            if parent_id is None:
                cls = type(parent)
                try:
                    source_file = inspect.getfile(cls)
                except (TypeError, OSError):
                    return
                if not path_filter.is_in_scope(source_file) and not path_filter.is_tracked_class(cls):
                    return
                tracked = path_filter.tracked_qualname(cls)
                ref = tracked if tracked else f"{source_file}:{cls.__qualname__}"
                parent_id = graph.record_instantiation(ref, id(parent))
            graph.record_ownership(id(parent), id(child), name)

        self._module_hook_handle = register_module_module_registration_hook(_on_register)

    def uninstall_module_hook(self) -> None:
        if self._module_hook_handle is not None:
            self._module_hook_handle.remove()
            self._module_hook_handle = None

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
            owned_id = graph.get_object_id(id(value))
            if owned_id is not None:
                graph.record_ownership(id(self_obj), id(value), name)
            elif isinstance(value, (list, tuple, set, frozenset)):
                for item in value:
                    item_id = graph.get_object_id(id(item))
                    if item_id is not None:
                        graph.record_ownership(id(self_obj), id(item), name)
            elif isinstance(value, dict):
                for item in value.values():
                    item_id = graph.get_object_id(id(item))
                    if item_id is not None:
                        graph.record_ownership(id(self_obj), id(item), name)

            if isinstance(value, (str, int, float, bool)):
                graph.record_attr(id(self_obj), name, str(value))
            elif value is None:
                graph.record_attr(id(self_obj), name, "None")
            elif owned_id is None:
                graph.record_attr(id(self_obj), name, type(value).__qualname__)

        try:
            cls.__setattr__ = _traced_setattr
        except TypeError:
            pass

    def patch_queue_class(self) -> None:
        try:
            import janus
        except ImportError:
            return

        queue_cls = janus.Queue
        if hasattr(queue_cls, "_tracer_patched"):
            return

        original_put = queue_cls._put
        original_get = queue_cls._get
        graph = self.graph

        def _traced_put(self_q: Any, *args: Any, **kwargs: Any) -> Any:
            result = original_put(self_q, *args, **kwargs)
            queue_id = getattr(self_q, "_tracer_queue_id", None)
            if queue_id is not None:
                seq = next(self_q._tracer_seq)
                item = args[0] if args else kwargs.get("item")
                graph.record_queue_event(queue_id, "put", f"{queue_id}-janus-{seq}", _safe_repr(item))
            return result

        def _traced_get(self_q: Any, *args: Any, **kwargs: Any) -> Any:
            result = original_get(self_q, *args, **kwargs)
            queue_id = getattr(self_q, "_tracer_queue_id", None)
            if queue_id is not None:
                seq = next(self_q._tracer_seq)
                graph.record_queue_event(queue_id, "get", f"{queue_id}-janus-{seq}", _safe_repr(result))
            return result

        queue_cls._put = _traced_put
        queue_cls._get = _traced_get
        queue_cls._tracer_patched = True

    def init_queue_instance(self, queue_obj: Any, queue_id: str) -> None:
        queue_obj._tracer_queue_id = queue_id
        queue_obj._tracer_seq = itertools.count()
