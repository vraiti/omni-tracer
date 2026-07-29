from __future__ import annotations

import itertools
from collections import deque
from typing import Any

_PRIMITIVE_TYPES = (str, int, float, bool, type(None))


def _safe_repr(obj: object) -> str:
    if isinstance(obj, _PRIMITIVE_TYPES):
        return repr(obj)
    return f"<{type(obj).__qualname__}>"


def _key_repr(key: object) -> str:
    try:
        s = repr(key)
    except Exception:
        s = str(id(key))
    return s[:64]


class _TracedContainerMixin:

    def _tracer_init(self, graph: Any, queue_id: str) -> None:
        object.__setattr__(self, "_tracer_graph", graph)
        object.__setattr__(self, "_tracer_queue_id", queue_id)
        object.__setattr__(self, "_tracer_seq", itertools.count())

    def _tracer_event(self, direction: str, tag: str, item: object) -> None:
        graph = object.__getattribute__(self, "_tracer_graph")
        qid = object.__getattribute__(self, "_tracer_queue_id")
        seq = next(object.__getattribute__(self, "_tracer_seq"))
        event_id = f"{qid}-{tag}-{seq}"
        graph.record_queue_event(qid, direction, event_id, _safe_repr(item))


class TracedDict(_TracedContainerMixin, dict):

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self._tracer_event("put", f"set-{_key_repr(key)}", value)

    def __getitem__(self, key: Any) -> Any:
        result = super().__getitem__(key)
        self._tracer_event("get", f"get-{_key_repr(key)}", result)
        return result

    def __delitem__(self, key: Any) -> None:
        super().__delitem__(key)
        self._tracer_event("put", f"del-{_key_repr(key)}", key)

    def get(self, key: Any, default: Any = None) -> Any:
        result = super().get(key, default)
        if key in self:
            self._tracer_event("get", f"get-{_key_repr(key)}", result)
        return result

    def pop(self, *args: Any) -> Any:
        key = args[0] if args else None
        result = super().pop(*args)
        self._tracer_event("get", f"pop-{_key_repr(key)}", result)
        return result

    def setdefault(self, key: Any, default: Any = None) -> Any:
        is_new = key not in self
        result = super().setdefault(key, default)
        if is_new:
            self._tracer_event("put", f"set-{_key_repr(key)}", result)
        return result

    def update(self, *args: Any, **kwargs: Any) -> None:
        super().update(*args, **kwargs)
        self._tracer_event("put", "update", None)

    def clear(self) -> None:
        super().clear()
        self._tracer_event("put", "clear", None)


class TracedList(_TracedContainerMixin, list):

    def append(self, value: Any) -> None:
        super().append(value)
        self._tracer_event("put", "append", value)

    def extend(self, values: Any) -> None:
        super().extend(values)
        self._tracer_event("put", "extend", None)

    def insert(self, index: int, value: Any) -> None:
        super().insert(index, value)
        self._tracer_event("put", "insert", value)

    def __setitem__(self, index: Any, value: Any) -> None:
        super().__setitem__(index, value)
        self._tracer_event("put", "setitem", value)

    def __delitem__(self, index: Any) -> None:
        super().__delitem__(index)
        self._tracer_event("put", "delitem", None)

    def __getitem__(self, index: Any) -> Any:
        result = super().__getitem__(index)
        self._tracer_event("get", "getitem", result)
        return result

    def pop(self, *args: Any) -> Any:
        result = super().pop(*args)
        self._tracer_event("get", "pop", result)
        return result

    def remove(self, value: Any) -> None:
        super().remove(value)
        self._tracer_event("put", "remove", value)

    def clear(self) -> None:
        super().clear()
        self._tracer_event("put", "clear", None)


class TracedDeque(_TracedContainerMixin, deque):

    def append(self, value: Any) -> None:
        super().append(value)
        self._tracer_event("put", "append", value)

    def appendleft(self, value: Any) -> None:
        super().appendleft(value)
        self._tracer_event("put", "appendleft", value)

    def extend(self, values: Any) -> None:
        super().extend(values)
        self._tracer_event("put", "extend", None)

    def extendleft(self, values: Any) -> None:
        super().extendleft(values)
        self._tracer_event("put", "extendleft", None)

    def insert(self, index: int, value: Any) -> None:
        super().insert(index, value)
        self._tracer_event("put", "insert", value)

    def __setitem__(self, index: Any, value: Any) -> None:
        super().__setitem__(index, value)
        self._tracer_event("put", "setitem", value)

    def __getitem__(self, index: Any) -> Any:
        result = super().__getitem__(index)
        self._tracer_event("get", "getitem", result)
        return result

    def pop(self, *args: Any) -> Any:
        result = super().pop(*args)
        self._tracer_event("get", "pop", result)
        return result

    def popleft(self) -> Any:
        result = super().popleft()
        self._tracer_event("get", "popleft", result)
        return result

    def remove(self, value: Any) -> None:
        super().remove(value)
        self._tracer_event("put", "remove", value)

    def clear(self) -> None:
        super().clear()
        self._tracer_event("put", "clear", None)


class TracedSet(_TracedContainerMixin, set):

    def add(self, value: Any) -> None:
        super().add(value)
        self._tracer_event("put", "add", value)

    def discard(self, value: Any) -> None:
        super().discard(value)
        self._tracer_event("put", "discard", value)

    def remove(self, value: Any) -> None:
        super().remove(value)
        self._tracer_event("put", "remove", value)

    def pop(self) -> Any:
        result = super().pop()
        self._tracer_event("get", "pop", result)
        return result

    def clear(self) -> None:
        super().clear()
        self._tracer_event("put", "clear", None)

    def update(self, *args: Any) -> None:
        super().update(*args)
        self._tracer_event("put", "update", None)

    def __ior__(self, other: Any) -> Any:
        result = super().__ior__(other)
        self._tracer_event("put", "update", None)
        return result


_CONTAINER_MAP: dict[type, type] = {
    dict: TracedDict,
    list: TracedList,
    deque: TracedDeque,
    set: TracedSet,
}


def wrap_container(value: object, graph: Any, queue_id: str) -> object | None:
    traced_cls = _CONTAINER_MAP.get(type(value))
    if traced_cls is None:
        return None
    wrapped = traced_cls(value)
    wrapped._tracer_init(graph, queue_id)
    return wrapped
