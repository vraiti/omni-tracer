import type { FunctionData, FuncCallNode } from "./types";

const MAX_DEPTH = 64;

export function getFuncName(ref: string): string {
  const last = ref.includes(":") ? ref.split(":").pop()! : ref;
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1) : last;
}

function getFuncLabel(ref: string, boundTo: string | undefined, objects: Record<string, { ref: string }> | null): string {
  const name = getFuncName(ref);
  if (boundTo && objects?.[boundTo]) {
    const cls = objects[boundTo].ref;
    const shortCls = cls.includes(":") ? cls.split(":").pop()! : cls.split(".").pop()!;
    const dot = shortCls.lastIndexOf(".");
    return (dot >= 0 ? shortCls.slice(dot + 1) : shortCls) + "." + name;
  }
  const file = ref.includes("/") ? ref.split(":")[0].split("/").pop()! : "";
  return file ? file + ":" + name : name;
}

export interface FuncIndexEntry {
  fid: string;
  label: string;
  descendantCount: number;
}

function allTargets(fn: { invokes: string[]; queue_invokes?: string[] }): string[] {
  const targets = fn.invokes;
  const qi = fn.queue_invokes;
  return qi && qi.length > 0 ? targets.concat(qi) : targets;
}

export function buildFuncIndex(
  functions: FunctionData,
  objects: Record<string, { ref: string }> | null,
  entrypoints?: string[] | null,
): FuncIndexEntry[] {
  const entries: FuncIndexEntry[] = [];

  if (entrypoints && entrypoints.length > 0) {
    for (const fid of entrypoints) {
      const fn = functions[fid];
      if (!fn) continue;
      entries.push({
        fid,
        label: getFuncLabel(fn.ref, fn.bound_to, objects),
        descendantCount: countDescendants(fid, functions),
      });
    }
  } else {
    for (const [fid, fn] of Object.entries(functions)) {
      if (fn.invokes.length === 0 && !(fn.queue_invokes && fn.queue_invokes.length > 0)) continue;
      entries.push({
        fid,
        label: getFuncLabel(fn.ref, fn.bound_to, objects),
        descendantCount: countDescendants(fid, functions),
      });
    }
  }

  entries.sort((a, b) => b.descendantCount - a.descendantCount);
  return entries;
}

function countDescendants(fid: string, functions: FunctionData): number {
  const seen = new Set<string>();
  const stack = [fid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const fn = functions[cur];
    if (fn) {
      for (const child of allTargets(fn)) stack.push(child);
    }
  }
  return seen.size - 1;
}

function collectReachable(rootId: string, functions: FunctionData): Set<string> {
  const reachable = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const fn = functions[cur];
    if (fn) {
      for (const child of allTargets(fn)) stack.push(child);
    }
  }
  return reachable;
}

export const MODULE_KEY = "__module__";

export function buildObjectMethods(
  functions: FunctionData,
  rootFuncId: string | null,
): Record<string, FuncCallNode[]> {
  const reachable = rootFuncId ? collectReachable(rootFuncId, functions) : null;

  const callerOf = new Map<string, string>();
  for (const [fid, fn] of Object.entries(functions)) {
    for (const child of allTargets(fn)) {
      callerOf.set(child, fid);
    }
  }

  const entryPoints = new Map<string, string[]>();
  for (const [fid, fn] of Object.entries(functions)) {
    if (!fn.bound_to) continue;
    if (reachable && !reachable.has(fid)) continue;
    const callerId = callerOf.get(fid);
    const callerBoundTo = callerId ? functions[callerId]?.bound_to : undefined;
    if (callerBoundTo === fn.bound_to) continue;
    const list = entryPoints.get(fn.bound_to);
    if (list) list.push(fid);
    else entryPoints.set(fn.bound_to, [fid]);
  }

  const result: Record<string, FuncCallNode[]> = {};
  for (const [objId, fids] of entryPoints) {
    result[objId] = deduplicateGroup(fids, functions, objId, 0);
  }

  if (rootFuncId && functions[rootFuncId] && !functions[rootFuncId].bound_to) {
    result[MODULE_KEY] = deduplicateGroup([rootFuncId], functions, null, 0);
  }

  return result;
}

function deduplicateGroup(
  fids: string[],
  functions: FunctionData,
  contextObj: string | null,
  depth: number,
): FuncCallNode[] {
  const byRef = new Map<string, { count: number; first: string }>();
  for (const fid of fids) {
    const fn = functions[fid];
    if (!fn) continue;
    const existing = byRef.get(fn.ref);
    if (existing) {
      existing.count++;
    } else {
      byRef.set(fn.ref, { count: 1, first: fid });
    }
  }

  const nodes: FuncCallNode[] = [];
  for (const [ref, { count, first }] of byRef) {
    const fn = functions[first];
    const boundTo = fn.bound_to || null;
    const isCrossObject = boundTo !== null && boundTo !== contextObj;

    let children: FuncCallNode[] = [];
    if (!isCrossObject && depth < MAX_DEPTH && allTargets(fn).length > 0) {
      children = deduplicateGroup(allTargets(fn), functions, contextObj, depth + 1);
    }

    nodes.push({
      ref,
      name: getFuncName(ref),
      count,
      boundTo,
      children,
    });
  }

  return nodes;
}
