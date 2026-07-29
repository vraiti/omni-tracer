import type { FunctionData, FuncCallNode } from "./types";

const MAX_DEPTH = 64;

export function getFuncName(ref: string): string {
  const last = ref.includes(":") ? ref.split(":").pop()! : ref;
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1) : last;
}

export function buildObjectMethods(
  functions: FunctionData,
): Record<string, FuncCallNode[]> {
  const callerOf = new Map<string, string>();
  for (const [fid, fn] of Object.entries(functions)) {
    for (const child of fn.invokes) {
      callerOf.set(child, fid);
    }
  }

  const entryPoints = new Map<string, string[]>();
  for (const [fid, fn] of Object.entries(functions)) {
    if (!fn.bound_to) continue;
    const callerId = callerOf.get(fid);
    const callerBoundTo = callerId ? functions[callerId]?.bound_to : undefined;
    if (callerBoundTo === fn.bound_to) continue;
    const list = entryPoints.get(fn.bound_to);
    if (list) list.push(fid);
    else entryPoints.set(fn.bound_to, [fid]);
  }

  const result: Record<string, FuncCallNode[]> = {};
  for (const [objUuid, fids] of entryPoints) {
    result[objUuid] = deduplicateGroup(fids, functions, objUuid, 0);
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
    if (!isCrossObject && depth < MAX_DEPTH && fn.invokes.length > 0) {
      children = deduplicateGroup(fn.invokes, functions, contextObj, depth + 1);
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
