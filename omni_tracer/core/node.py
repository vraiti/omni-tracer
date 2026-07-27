from __future__ import annotations

import uuid
from dataclasses import dataclass, field


def _new_uuid() -> str:
    return str(uuid.uuid4())


@dataclass
class FunctionNode:
    ref: str
    process: str
    uuid: str = field(default_factory=_new_uuid)
    invokes: list[str] = field(default_factory=list)
    instantiates: list[str] = field(default_factory=list)
    coroutine: str | None = None
    bound_to: str | None = None

    def to_dict(self) -> dict:
        d = {
            "ref": self.ref,
            "invokes": self.invokes,
            "instantiates": self.instantiates,
            "process": self.process,
        }
        if self.coroutine is not None:
            d["coroutine"] = self.coroutine
        if self.bound_to is not None:
            d["bound_to"] = self.bound_to
        return d


@dataclass
class ObjectNode:
    ref: str
    process: str
    uuid: str = field(default_factory=_new_uuid)
    owns: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "ref": self.ref,
            "owns": self.owns,
            "process": self.process,
        }
