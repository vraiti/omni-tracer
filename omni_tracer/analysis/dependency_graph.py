from __future__ import annotations

from collections import defaultdict
from typing import Any


def build_dependency_graph(data: dict[str, Any]) -> None:
    functions = data.get("functions", {})
    queue_events = data.get("queue_events", [])

    queue_adj = _build_queue_adjacency(queue_events)

    for fid, targets in queue_adj.items():
        fn = functions.get(fid)
        if fn is not None:
            fn["queue_invokes"] = sorted(targets)

    called = set()
    for fn in functions.values():
        for child in fn.get("invokes", []):
            called.add(child)
        for child in fn.get("queue_invokes", []):
            called.add(child)

    entrypoints = []
    for fid, fn in functions.items():
        invokes = fn.get("invokes", [])
        q_invokes = fn.get("queue_invokes", [])
        if (invokes or q_invokes) and fid not in called:
            entrypoints.append(fid)

    data["entrypoints"] = entrypoints


def _build_queue_adjacency(
    queue_events: list[dict[str, Any]],
) -> dict[str, list[str]]:
    by_queue: dict[str, dict[str, list[str]]] = defaultdict(
        lambda: {"put": [], "get": []}
    )
    puts_by_event_id: dict[str, str] = {}
    gets_by_event_id: dict[str, str] = {}

    for ev in queue_events:
        caller = ev.get("caller")
        if caller is None:
            continue
        direction = ev.get("direction", "")
        qid = ev.get("queue_id", "")
        event_id = ev.get("id", "")
        if direction == "put":
            by_queue[qid]["put"].append(caller)
            if event_id:
                puts_by_event_id[event_id] = caller
        elif direction == "get":
            by_queue[qid]["get"].append(caller)
            if event_id:
                gets_by_event_id[event_id] = caller

    adj: dict[str, set[str]] = defaultdict(set)

    for groups in by_queue.values():
        put_callers = set(groups["put"])
        get_callers = set(groups["get"])
        for pc in put_callers:
            adj[pc].update(get_callers - {pc})

    for event_id, put_caller in puts_by_event_id.items():
        get_caller = gets_by_event_id.get(event_id)
        if get_caller and get_caller != put_caller:
            adj[put_caller].add(get_caller)

    return {k: sorted(v) for k, v in adj.items() if v}
