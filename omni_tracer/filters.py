from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ArgCaptureSpec:
    """Specifies which function arguments to capture at runtime.

    ``func_pattern`` is matched against the code object's qualname
    (e.g. ``Scheduler.add_request``).  ``paths`` is a list of dotted
    extraction paths where the first segment is a local variable name
    and subsequent segments are attribute lookups
    (e.g. ``["request.request_id", "request.status"]``).
    """
    func_pattern: str
    paths: list[str] = field(default_factory=lambda: ["self"])


class PathFilter:
    def __init__(self) -> None:
        self._cache: dict[str, bool] = {}
        self._prefixes = self._resolve_prefixes()
        self._tracked_classes: set[str] = set()

    def _resolve_prefixes(self) -> tuple[str, ...]:
        prefixes: list[str] = []
        for pkg in ("vllm_omni", "vllm"):
            spec = importlib.util.find_spec(pkg)
            if spec and spec.origin:
                prefixes.append(str(Path(spec.origin).parent))
        return tuple(prefixes)

    def is_in_scope(self, filename: str) -> bool:
        result = self._cache.get(filename)
        if result is None:
            result = filename.startswith(self._prefixes)
            self._cache[filename] = result
        return result

    def track_class(self, qualname: str) -> None:
        self._tracked_classes.add(qualname)

    def is_tracked_class(self, cls: type) -> bool:
        if not self._tracked_classes:
            return False
        qualname = f"{cls.__module__}.{cls.__qualname__}"
        return qualname in self._tracked_classes

    def tracked_qualname(self, cls: type) -> str | None:
        if not self._tracked_classes:
            return None
        qualname = f"{cls.__module__}.{cls.__qualname__}"
        if qualname in self._tracked_classes:
            return qualname
        return None
