import type { TraceData, TraceObject, ParentMap, CreationOrder, EffectiveParentMap } from "./types";
import { pinnedRootClasses, traceData as stateTraceData } from "./state";

// Refs with "/" are file paths like "/path/to/file.py:ClassName" — extract the class after the last ":".
// Refs without "/" are bare names (no file path) — return as-is.
export function getClassName(ref: string): string {
  if (ref.includes("/")) {
    const parts = ref.split(":");
    return parts[parts.length - 1] || ref;
  }
  return ref;
}

export function getOwned(obj: TraceObject): [string, string][] {
  const owns = obj.owns || {};
  if (Array.isArray(owns)) return owns.map(u => [u, ""]);
  return Object.entries(owns);
}

export function getOwnedIds(obj: TraceObject): string[] {
  const owns = obj.owns || {};
  if (Array.isArray(owns)) return owns;
  return Object.keys(owns);
}

export function synthesizeLocalOwnership(objects: TraceData): void {
  const owned = new Set<string>();
  for (const obj of Object.values(objects)) {
    for (const child of getOwnedIds(obj)) owned.add(child);
  }
  for (const [id, obj] of Object.entries(objects)) {
    if (owned.has(id)) continue;
    if (!obj.created_by) continue;
    const creator = objects[obj.created_by];
    if (!creator) continue;
    const funcName = obj.created_in?.split(".").pop() || "?";
    const label = "local<" + funcName + ">";
    if (Array.isArray(creator.owns)) {
      creator.owns = Object.fromEntries(creator.owns.map(u => [u, ""]));
    }
    if (!creator.owns) creator.owns = {};
    (creator.owns as Record<string, string>)[id] = label;
  }
}

export function buildParentMap(objects: TraceData): ParentMap {
  const pm: ParentMap = {};
  for (const id of Object.keys(objects)) {
    for (const child of getOwnedIds(objects[id])) {
      if (!pm[child]) pm[child] = [];
      pm[child].push(id);
    }
  }
  return pm;
}

export function buildCreationOrder(objects: TraceData): CreationOrder {
  const order: CreationOrder = {};
  let i = 0;
  for (const id of Object.keys(objects)) {
    order[id] = i++;
  }
  return order;
}

let _reachCache: Record<string, boolean> = {};

export function clearReachCache(): void {
  _reachCache = {};
}

export function canReach(objects: TraceData, from: string, to: string, visited: Set<string>): boolean {
  const key = from + ">" + to;
  if (key in _reachCache) return _reachCache[key];
  if (visited.has(from)) return false;
  visited.add(from);
  const obj = objects[from];
  if (!obj) { _reachCache[key] = false; return false; }
  for (const child of getOwnedIds(obj)) {
    if (child === to || canReach(objects, child, to, visited)) {
      _reachCache[key] = true;
      return true;
    }
  }
  _reachCache[key] = false;
  return false;
}

export function isPinnedRoot(id: string): boolean {
  if (!stateTraceData) return false;
  const obj = stateTraceData[id];
  if (!obj) return false;
  return pinnedRootClasses.has(getClassName(obj.ref));
}

export function buildEffectiveParentMap(
  objects: TraceData,
  rawParentMap: ParentMap,
  co: CreationOrder,
): EffectiveParentMap {
  const ep: EffectiveParentMap = {};
  for (const [child, parents] of Object.entries(rawParentMap)) {
    if (isPinnedRoot(child)) continue;
    const validParents = parents.filter(p => {
      if (co[p] < co[child]) return true;
      if (!canReach(objects, child, p, new Set())) return true;
      return false;
    });
    if (validParents.length > 1) {
      const createdBy = objects[child]?.created_by;
      if (createdBy && validParents.includes(createdBy)) {
        ep[child] = [createdBy];
        continue;
      }
      const earliest = validParents.reduce((a, b) => (co[a] ?? 0) < (co[b] ?? 0) ? a : b);
      ep[child] = [earliest];
      continue;
    }
    if (validParents.length > 0) {
      ep[child] = validParents;
    }
  }
  return ep;
}

export function findRoots(objects: TraceData, epm: EffectiveParentMap): string[] {
  const allIds = Object.keys(objects);
  const roots = allIds.filter(u => !epm[u] || epm[u].length === 0);

  const rooted = new Set<string>();
  function markReachable(id: string, visited: Set<string>) {
    if (visited.has(id)) return;
    visited.add(id);
    rooted.add(id);
    const obj = objects[id];
    if (!obj) return;
    for (const child of getOwnedIds(obj)) {
      if (!objects[child]) continue;
      const childOwns = objects[child].owns;
      const ownsMap = Array.isArray(childOwns) ? {} : (childOwns || {});
      if (!canReach(objects, child, id, new Set()) || id in ownsMap) {
        markReachable(child, visited);
      }
    }
  }
  for (const r of roots) markReachable(r, new Set());

  for (const id of allIds) {
    if (!rooted.has(id)) {
      roots.push(id);
      markReachable(id, new Set());
    }
  }

  return roots;
}

const IDENTIFIER_ATTRS: Record<string, string> = {
  "SharedMemory": "_name",
  "SpinCondition": "notify_address",
};

export function findIdentifierPairs(objects: TraceData): [string, string][] {
  const groups = new Map<string, { id: string; process: string }[]>();

  for (const [id, obj] of Object.entries(objects)) {
    const cls = getClassName(obj.ref);
    const shortCls = cls.includes(".") ? cls.split(".").pop()! : cls;
    const attrKey = IDENTIFIER_ATTRS[shortCls];
    if (!attrKey) continue;
    const idValue = obj.attrs?.[attrKey];
    if (!idValue) continue;
    const key = cls + ":" + idValue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id, process: obj.process });
  }

  const pairs: [string, string][] = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].process !== members[j].process) {
          pairs.push([members[i].id, members[j].id]);
        }
      }
    }
  }
  return pairs;
}

export function participatesInOwnership(id: string, objects: TraceData, pm: ParentMap): boolean {
  const obj = objects[id];
  if (!obj) return false;
  if (getOwnedIds(obj).length > 0) return true;
  if (pm[id] && pm[id].length > 0) return true;
  return false;
}
