from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import threading
from typing import Any

from tracer._tracer import (
    CallRecord,
    Database,
    ObjectRecord,
    OwnershipHook,
    PathFilter,
    get_call_id,
    install,
    install_thread,
    uninstall,
)
from tracer.ast_index import AstIndex
from tracer.ipc import patch_message_queue
from tracer.postprocess import postprocess
from tracer.process_hook import ProcessHook


class TraceHook:
    def __init__(
        self,
        db: Database,
        ast_index: AstIndex,
        path_filter: PathFilter,
    ) -> None:
        self.db = db
        self.ast_index = ast_index
        self.path_filter = path_filter
        self._ownership_hook: OwnershipHook | None = None

    def set_ownership_hook(self, hook: OwnershipHook) -> None:
        self._ownership_hook = hook

    def _c_make_record(self, frame: Any, call_id: int, caller_id: int, call_lineno: int) -> Any:
        code = frame.f_code
        ref = self.ast_index.ref_from_code(code)
        function_id = self.ast_index.get_function_id(ref)

        self_obj = frame.f_locals.get("self")
        obj_id = 0
        if self_obj is not None:
            obj_id = getattr(self_obj, "__tr_idx", 0)

        rec = CallRecord(
            call_id=call_id,
            function_id=function_id,
            caller_id=caller_id,
            call_lineno=call_lineno,
            obj_id=obj_id,
        )
        self.db.add_call(rec)

        if code.co_name == "__init__" and self_obj is not None:
            self._handle_init(frame, code, self_obj, call_id)
            obj_id = getattr(self_obj, "__tr_idx", 0)
            rec.obj_id = obj_id

        cf_lines = self.ast_index.get_control_flow_lines(ref)
        return (rec, cf_lines)

    def _c_handle_oos_init(self, frame: Any, call_id: int, caller_id: int, call_lineno: int) -> Any:
        code = frame.f_code
        self_obj = frame.f_locals.get("self")
        if self_obj is None:
            return None
        if not self.path_filter.is_tracked_class(type(self_obj)):
            return None

        ref = self.ast_index.ref_from_code(code)
        function_id = self.ast_index.get_function_id(ref)
        obj_id = getattr(self_obj, "__tr_idx", 0)

        rec = CallRecord(
            call_id=call_id,
            function_id=function_id,
            caller_id=caller_id,
            call_lineno=call_lineno,
            obj_id=obj_id,
        )
        self.db.add_call(rec)

        self._handle_init(frame, code, self_obj, call_id)
        obj_id = getattr(self_obj, "__tr_idx", 0)
        rec.obj_id = obj_id

        cf_lines = self.ast_index.get_control_flow_lines(ref)
        return (rec, cf_lines)

    def _handle_init(self, frame: Any, code: Any, self_obj: Any, call_id: int) -> None:
        cls = type(self_obj)
        cls_code = getattr(getattr(cls, "__init__", None), "__code__", None)
        if cls_code is not code:
            return

        obj_rec = ObjectRecord(call_id=call_id)
        obj_idx = self.db.add_object(obj_rec)
        object.__setattr__(self_obj, "__tr_idx", obj_idx)

        if self._ownership_hook is not None:
            self._ownership_hook.patch_class(cls)


def serialize(db: Database, ast_index: AstIndex, output: str) -> None:
    if os.path.exists(output):
        os.remove(output)
    conn = sqlite3.connect(output)
    c = conn.cursor()

    c.executescript("""
        CREATE TABLE meta (pid INTEGER);
        CREATE TABLE functions (function_id INTEGER PRIMARY KEY, ref TEXT NOT NULL);
        CREATE TABLE calls (
            pid INTEGER NOT NULL,
            call_id INTEGER NOT NULL,
            function_id INTEGER NOT NULL,
            caller_id INTEGER NOT NULL,
            call_lineno INTEGER NOT NULL,
            obj_id INTEGER NOT NULL,
            control_flow BLOB,
            PRIMARY KEY (pid, call_id)
        );
        CREATE TABLE attr_reads (
            pid INTEGER NOT NULL,
            call_id INTEGER NOT NULL,
            caller_id INTEGER NOT NULL,
            write_call_lineno INTEGER NOT NULL,
            read_call_lineno INTEGER NOT NULL
        );
        CREATE TABLE objects (
            pid INTEGER NOT NULL,
            obj_idx INTEGER NOT NULL,
            call_id INTEGER NOT NULL,
            PRIMARY KEY (pid, obj_idx)
        );
        CREATE TABLE members (
            pid INTEGER NOT NULL,
            obj_idx INTEGER NOT NULL,
            attr TEXT NOT NULL,
            child_idx INTEGER NOT NULL
        );
        CREATE TABLE ipc (
            name TEXT NOT NULL,
            obj_idx INTEGER NOT NULL
        );
    """)

    c.execute("INSERT INTO meta VALUES (?)", (os.getpid(),))

    func_map = {v: k for k, v in ast_index._func_to_id.items()}
    c.executemany(
        "INSERT INTO functions VALUES (?, ?)",
        func_map.items(),
    )

    _TAINT_ID = (1 << 64) - 1
    pid = os.getpid()

    n_calls = 0
    for rec in db.calls:
        cf = bytes(rec.control_flow) if rec.control_flow else None
        caller_id = 0 if rec.caller_id == _TAINT_ID else rec.caller_id
        c.execute(
            "INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?)",
            (pid, rec.call_id, rec.function_id, caller_id, rec.call_lineno, rec.obj_id, cf),
        )
        for ar in rec.attr_reads:
            ar_caller = 0 if ar.caller_id == _TAINT_ID else ar.caller_id
            c.execute(
                "INSERT INTO attr_reads VALUES (?, ?, ?, ?, ?)",
                (pid, rec.call_id, ar_caller, ar.write_call_lineno, ar.read_call_lineno),
            )
        n_calls += 1

    n_objects = 0
    for idx, obj in enumerate(db.objects):
        c.execute("INSERT INTO objects VALUES (?, ?, ?)", (pid, idx, obj.call_id))
        for attr, child_idx in dict(obj.members).items():
            c.execute("INSERT INTO members VALUES (?, ?, ?, ?)", (pid, idx, attr, child_idx))
        n_objects += 1

    n_ipc = 0
    for irec in db.ipc:
        c.execute("INSERT INTO ipc VALUES (?, ?)", (irec.name, irec.obj_idx))
        n_ipc += 1

    conn.commit()
    conn.close()

    print(f"Trace written to {output} ({n_calls} calls, {n_objects} objects, {n_ipc} ipc)", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="python-tracer")
    parser.add_argument("--prefix", action="append", default=None, help="scope prefix (repeatable; omit to auto-detect vllm)")
    parser.add_argument("--tracked", type=str, default=None, help="path to tracked.txt")
    parser.add_argument("--output", type=str, default="trace.db", help="output file")
    parser.add_argument("--no-postprocess", action="store_true", help="skip postprocessing")
    parser.add_argument("--taint-notrace", action="append", default=None, help="suppress tracing inside functions matching this qualname substring (repeatable)")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="command to run")

    args = parser.parse_args()

    if not args.command:
        parser.error("no command specified")

    path_filter = PathFilter(prefixes=args.prefix, tracked_file=args.tracked)
    ast_index = AstIndex()
    ast_index.preprocess(path_filter)

    db = Database()
    hook = TraceHook(db, ast_index, path_filter)
    ownership = OwnershipHook(db, hook)
    hook.set_ownership_hook(ownership)

    patch_message_queue(db)

    # Install trace function
    prefixes = list(path_filter._prefixes)
    install(hook, prefixes, taint_patterns=args.taint_notrace)

    # Monkey-patch multiprocessing to trace child processes
    proc_hook = ProcessHook(
        prefixes=prefixes,
        tracked_file=args.tracked,
        taint_patterns=args.taint_notrace,
        no_postprocess=args.no_postprocess,
    )
    proc_hook.install()

    # Monkey-patch Thread.run for new threads
    _original_run = threading.Thread.run
    def _patched_run(self: threading.Thread) -> None:
        install_thread()
        _original_run(self)
    threading.Thread.run = _patched_run  # type: ignore

    cmd = args.command
    if cmd[0] == "--":
        cmd = cmd[1:]

    sys.argv = cmd
    script = cmd[0]
    if not os.path.exists(script):
        import shutil
        resolved = shutil.which(script)
        if resolved:
            script = resolved

    code: Any = None
    with open(script) as f:
        code = compile(f.read(), script, "exec")

    try:
        exec(code, {"__name__": "__main__", "__file__": script})
    except SystemExit:
        pass
    finally:
        uninstall()
        proc_hook.uninstall()
        proc_hook.join_children()
        serialize(db, ast_index, args.output)

        child_dbs = proc_hook.child_trace_paths()
        if child_dbs:
            import time as _time
            conn = sqlite3.connect(args.output)
            for child_db in child_dbs:
                print(f"Merging child trace {child_db}", file=sys.stderr)
                for attempt in range(10):
                    try:
                        conn.execute("ATTACH DATABASE ? AS child", (child_db,))
                        conn.execute("INSERT OR IGNORE INTO meta SELECT * FROM child.meta")
                        conn.execute("INSERT OR IGNORE INTO functions SELECT * FROM child.functions")
                        conn.execute("INSERT INTO calls SELECT * FROM child.calls")
                        conn.execute("INSERT INTO attr_reads SELECT * FROM child.attr_reads")
                        conn.execute("INSERT INTO objects SELECT * FROM child.objects")
                        conn.execute("INSERT INTO members SELECT * FROM child.members")
                        conn.execute("INSERT INTO ipc SELECT * FROM child.ipc")
                        conn.execute("DETACH DATABASE child")
                        break
                    except sqlite3.OperationalError:
                        try:
                            conn.execute("DETACH DATABASE child")
                        except Exception:
                            pass
                        if attempt < 9:
                            _time.sleep(1)
                        else:
                            print(f"Failed to merge {child_db} after 10 attempts", file=sys.stderr)
            conn.commit()
            conn.close()

        if not args.no_postprocess:
            postprocess(args.output)


if __name__ == "__main__":
    main()
