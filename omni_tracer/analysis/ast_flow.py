from __future__ import annotations

import ast
import inspect
import textwrap
import types
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class FlowNodeKind(Enum):
    PARAM = "param"
    LOCAL = "local"
    CALL_RESULT = "call_result"
    ATTR_ACCESS = "attr_access"
    RETURN_EXPR = "return_expr"


@dataclass(frozen=True)
class FlowNode:
    kind: FlowNodeKind
    name: str
    line: int = 0
    func_expr: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"kind": self.kind.value, "name": self.name}
        if self.line:
            d["line"] = self.line
        if self.func_expr:
            d["func_expr"] = self.func_expr
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FlowNode:
        return cls(
            kind=FlowNodeKind(d["kind"]),
            name=d["name"],
            line=d.get("line", 0),
            func_expr=d.get("func_expr", ""),
        )


@dataclass(frozen=True)
class FlowEdge:
    source: FlowNode
    sink: FlowNode
    line: int = 0

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "source": self.source.to_dict(),
            "sink": self.sink.to_dict(),
        }
        if self.line:
            d["line"] = self.line
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FlowEdge:
        return cls(
            source=FlowNode.from_dict(d["source"]),
            sink=FlowNode.from_dict(d["sink"]),
            line=d.get("line", 0),
        )


@dataclass
class FunctionFlow:
    """Intra-function dataflow graph built from AST."""
    ref: str
    params: list[FlowNode] = field(default_factory=list)
    nodes: list[FlowNode] = field(default_factory=list)
    edges: list[FlowEdge] = field(default_factory=list)
    call_sites: list[CallSite] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "params": [n.to_dict() for n in self.params],
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
            "call_sites": [c.to_dict() for c in self.call_sites],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FunctionFlow:
        return cls(
            ref=d["ref"],
            params=[FlowNode.from_dict(n) for n in d.get("params", [])],
            nodes=[FlowNode.from_dict(n) for n in d.get("nodes", [])],
            edges=[FlowEdge.from_dict(e) for e in d.get("edges", [])],
            call_sites=[CallSite.from_dict(c) for c in d.get("call_sites", [])],
        )


@dataclass
class CallSite:
    """A function call within the analyzed function."""
    line: int
    func_expr: str
    arg_exprs: list[str]
    kwarg_exprs: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "line": self.line,
            "func_expr": self.func_expr,
            "arg_exprs": self.arg_exprs,
        }
        if self.kwarg_exprs:
            d["kwarg_exprs"] = self.kwarg_exprs
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CallSite:
        return cls(
            line=d["line"],
            func_expr=d["func_expr"],
            arg_exprs=d.get("arg_exprs", []),
            kwarg_exprs=d.get("kwarg_exprs", {}),
        )


_cache: dict[int, FunctionFlow | None] = {}
_ref_cache: dict[str, FunctionFlow | None] = {}
_file_ast_cache: dict[str, ast.Module | None] = {}


def get_function_flow(code: types.CodeType, ref: str = "") -> FunctionFlow | None:
    code_id = id(code)
    if code_id in _cache:
        return _cache[code_id]
    flow = _build_flow(code, ref)
    _cache[code_id] = flow
    return flow


def get_function_flow_from_ref(ref: str) -> FunctionFlow | None:
    if ref in _ref_cache:
        return _ref_cache[ref]
    flow = _build_flow_from_ref(ref)
    _ref_cache[ref] = flow
    return flow


def _build_flow(code: types.CodeType, ref: str) -> FunctionFlow | None:
    try:
        source = inspect.getsource(code)
    except (OSError, TypeError):
        return None
    source = textwrap.dedent(source)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    func_def = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_def = node
            break
    if func_def is None:
        return None

    builder = _FlowBuilder(ref or code.co_qualname, func_def)
    builder.build()
    return builder.flow


def _build_flow_from_ref(ref: str) -> FunctionFlow | None:
    parts = ref.split(":")
    if len(parts) != 2:
        return None
    filename, qualname = parts
    tree = _get_file_ast(filename)
    if tree is None:
        return None
    func_def = _find_func_by_qualname(tree, qualname)
    if func_def is None:
        return None
    builder = _FlowBuilder(ref, func_def)
    builder.build()
    return builder.flow


def _get_file_ast(filename: str) -> ast.Module | None:
    if filename in _file_ast_cache:
        return _file_ast_cache[filename]
    try:
        with open(filename) as f:
            source = f.read()
        tree = ast.parse(source, filename)
    except (OSError, SyntaxError):
        tree = None
    _file_ast_cache[filename] = tree
    return tree


def _find_func_by_qualname(
    tree: ast.Module, qualname: str,
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    parts = qualname.split(".")
    scope: ast.AST = tree
    for i, part in enumerate(parts):
        found = None
        for node in ast.iter_child_nodes(scope):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if node.name == part:
                    found = node
                    break
        if found is None:
            return None
        scope = found
    if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return scope
    return None


def _expr_to_str(node: ast.expr) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "<opaque>"


def _expr_to_flow_node(node: ast.expr, line: int) -> FlowNode:
    if isinstance(node, ast.Name):
        return FlowNode(FlowNodeKind.LOCAL, node.id, line)
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return FlowNode(
            FlowNodeKind.ATTR_ACCESS,
            f"{node.value.id}.{node.attr}",
            line,
        )
    return FlowNode(FlowNodeKind.LOCAL, _expr_to_str(node), line)


class _FlowBuilder(ast.NodeVisitor):
    def __init__(self, ref: str, func_def: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.func_def = func_def
        self.flow = FunctionFlow(ref=ref)
        self._node_set: set[FlowNode] = set()

    def build(self) -> None:
        self._extract_params()
        for stmt in self.func_def.body:
            self.visit(stmt)

    def _add_node(self, node: FlowNode) -> FlowNode:
        if node not in self._node_set:
            self._node_set.add(node)
            self.flow.nodes.append(node)
        return node

    def _add_edge(self, source: FlowNode, sink: FlowNode, line: int = 0) -> None:
        self._add_node(source)
        self._add_node(sink)
        self.flow.edges.append(FlowEdge(source, sink, line))

    def _extract_params(self) -> None:
        args = self.func_def.args
        for arg in args.args + args.posonlyargs + args.kwonlyargs:
            p = FlowNode(FlowNodeKind.PARAM, arg.arg, self.func_def.lineno)
            self.flow.params.append(p)
            self._add_node(p)
            local = FlowNode(FlowNodeKind.LOCAL, arg.arg, self.func_def.lineno)
            self._add_edge(p, local, self.func_def.lineno)

    def visit_Assign(self, node: ast.Assign) -> None:
        for target in node.targets:
            self._handle_assignment(target, node.value, node.lineno)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None and node.target is not None:
            self._handle_assignment(node.target, node.value, node.lineno)
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:
        ret_node = FlowNode(FlowNodeKind.RETURN_EXPR, "", node.lineno)
        self._add_node(ret_node)
        if node.value is not None:
            source = self._resolve_expr(node.value, node.lineno)
            self._add_edge(source, ret_node, node.lineno)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:
        if isinstance(node.value, ast.Call):
            self._record_call_site(node.value, node.lineno)
        self.generic_visit(node)

    def _handle_assignment(self, target: ast.expr, value: ast.expr, line: int) -> None:
        source = self._resolve_expr(value, line)
        if isinstance(target, ast.Name):
            sink = FlowNode(FlowNodeKind.LOCAL, target.id, line)
            self._add_edge(source, sink, line)
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            sink = FlowNode(
                FlowNodeKind.ATTR_ACCESS,
                f"{target.value.id}.{target.attr}",
                line,
            )
            self._add_edge(source, sink, line)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._handle_assignment(elt, value, line)

    def _resolve_expr(self, node: ast.expr, line: int) -> FlowNode:
        if isinstance(node, ast.Name):
            return self._add_node(FlowNode(FlowNodeKind.LOCAL, node.id, line))
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            return self._add_node(FlowNode(
                FlowNodeKind.ATTR_ACCESS,
                f"{node.value.id}.{node.attr}",
                line,
            ))
        if isinstance(node, ast.Call):
            self._record_call_site(node, line)
            func_expr = _expr_to_str(node.func)
            return self._add_node(FlowNode(
                FlowNodeKind.CALL_RESULT, func_expr, line, func_expr,
            ))
        if isinstance(node, ast.IfExp):
            body = self._resolve_expr(node.body, line)
            orelse = self._resolve_expr(node.orelse, line)
            merged = self._add_node(FlowNode(FlowNodeKind.LOCAL, f"<ternary@{line}>", line))
            self._add_edge(body, merged, line)
            self._add_edge(orelse, merged, line)
            return merged
        if isinstance(node, ast.Await):
            return self._resolve_expr(node.value, line)
        return self._add_node(FlowNode(FlowNodeKind.LOCAL, _expr_to_str(node), line))

    def _record_call_site(self, call: ast.Call, line: int) -> None:
        func_expr = _expr_to_str(call.func)
        arg_exprs = [_expr_to_str(a) for a in call.args]
        kwarg_exprs: dict[str, str] = {}
        for kw in call.keywords:
            if kw.arg is not None:
                kwarg_exprs[kw.arg] = _expr_to_str(kw.value)
        self.flow.call_sites.append(CallSite(line, func_expr, arg_exprs, kwarg_exprs))
        for i, arg in enumerate(call.args):
            source = self._resolve_expr(arg, line)
            param_sink = FlowNode(
                FlowNodeKind.PARAM,
                f"{func_expr}:arg{i}",
                line,
                func_expr,
            )
            self._add_edge(source, param_sink, line)
        for kw in call.keywords:
            if kw.arg is not None:
                source = self._resolve_expr(kw.value, line)
                param_sink = FlowNode(
                    FlowNodeKind.PARAM,
                    f"{func_expr}:{kw.arg}",
                    line,
                    func_expr,
                )
                self._add_edge(source, param_sink, line)
