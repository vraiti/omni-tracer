from __future__ import annotations

import importlib.util
from pathlib import Path


class PathFilter:
    def __init__(self) -> None:
        self._cache: dict[str, bool] = {}
        self._prefixes = self._resolve_prefixes()

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
