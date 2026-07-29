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
    captured_args: dict[str, str] | None = None
    timestamp: float | None = None
    arg_ids: dict[str, int] | None = None
    arg_values: dict[str, str] | None = None
    return_id: int | None = None
    return_value: str | None = None

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
        if self.captured_args is not None:
            d["captured_args"] = self.captured_args
        if self.timestamp is not None:
            d["timestamp"] = self.timestamp
        if self.arg_ids is not None:
            d["arg_ids"] = self.arg_ids
        if self.arg_values is not None:
            d["arg_values"] = self.arg_values
        if self.return_id is not None:
            d["return_id"] = self.return_id
        if self.return_value is not None:
            d["return_value"] = self.return_value
        return d


@dataclass
class ObjectNode:
    ref: str
    process: str
    uuid: str = ""
    owns: dict[str, str] = field(default_factory=dict)
    created_by: str | None = None
    created_in: str | None = None
    attrs: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "ref": self.ref,
            "owns": self.owns,
            "process": self.process,
        }
        if self.created_by is not None:
            d["created_by"] = self.created_by
        if self.created_in is not None:
            d["created_in"] = self.created_in
        if self.attrs:
            d["attrs"] = self.attrs
        return d
