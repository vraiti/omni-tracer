from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FunctionNode:
    ref: str
    process: str
    uuid: str = ""
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
    uuid: str = ""
    owns: dict[str, str] = field(default_factory=dict)
    created_by: str | None = None

    def to_dict(self) -> dict:
        d = {
            "ref": self.ref,
            "owns": self.owns,
            "process": self.process,
        }
        if self.created_by is not None:
            d["created_by"] = self.created_by
        return d
