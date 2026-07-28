import type { TraceData, TraceObject, ParentMap, CreationOrder, EffectiveParentMap } from "./types";
import { pinnedRootClasses, traceData as stateTraceData } from "./state";

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

export function getOwnedUuids(obj: TraceObject): string[] {
  const owns = obj.owns || {};
  if (Array.isArray(owns)) return owns;
  return Object.keys(owns);
}

export function buildParentMap(objects: TraceData): ParentMap {
  const pm: ParentMap = {};
  for (const uuid of Object.keys(objects)) {
    for (const child of getOwnedUuids(objects[uuid])) {
      if (!pm[child]) pm[child] = [];
      pm[child].push(uuid);
    }
  }
  return pm;
}

export function buildCreationOrder(objects: TraceData): CreationOrder {
  const order: CreationOrder = {};
  let i = 0;
  for (const uuid of Object.keys(objects)) {
    order[uuid] = i++;
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
  for (const child of getOwnedUuids(obj)) {
    if (child === to || canReach(objects, child, to, visited)) {
      _reachCache[key] = true;
      return true;
    }
  }
  _reachCache[key] = false;
  return false;
}

export function isPinnedRoot(uuid: string): boolean {
  if (!stateTraceData) return false;
  const obj = stateTraceData[uuid];
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
  const allUuids = Object.keys(objects);
  const roots = allUuids.filter(u => !epm[u] || epm[u].length === 0);

  const rooted = new Set<string>();
  function markReachable(uuid: string, visited: Set<string>) {
    if (visited.has(uuid)) return;
    visited.add(uuid);
    rooted.add(uuid);
    const obj = objects[uuid];
    if (!obj) return;
    for (const child of getOwnedUuids(obj)) {
      if (!objects[child]) continue;
      const childOwns = objects[child].owns;
      const ownsMap = Array.isArray(childOwns) ? {} : (childOwns || {});
      if (!canReach(objects, child, uuid, new Set()) || uuid in ownsMap) {
        markReachable(child, visited);
      }
    }
  }
  for (const r of roots) markReachable(r, new Set());

  for (const uuid of allUuids) {
    if (!rooted.has(uuid)) {
      roots.push(uuid);
      markReachable(uuid, new Set());
    }
  }

  return roots;
}

export function participatesInOwnership(uuid: string, objects: TraceData, pm: ParentMap): boolean {
  const obj = objects[uuid];
  if (!obj) return false;
  if (getOwnedUuids(obj).length > 0) return true;
  if (pm[uuid] && pm[uuid].length > 0) return true;
  return false;
}
