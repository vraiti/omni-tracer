import type { TraceData, ParentMap, CreationOrder, EffectiveParentMap } from "./types";

export let traceData: TraceData | null = null;
export let traceFileName: string | null = null;
export let parentMap: ParentMap = {};
export let rendered: Record<string, boolean> = {};
export let collapsedSet = new Set<string>();
export let excludedClasses = new Set<string>();
export let pinnedRootClasses = new Set<string>();
export let creationOrder: CreationOrder = {};
export let effectiveParentMap: EffectiveParentMap = {};
export let rootOrder: Record<string, number> = {};
export let rootRows: string[][] = [];
export let ownershipOverrides: Record<string, string> = {};

export function setTraceData(data: TraceData) { traceData = data; }
export function setTraceFileName(name: string) { traceFileName = name; }
export function setParentMap(pm: ParentMap) { parentMap = pm; }
export function setRendered(r: Record<string, boolean>) { rendered = r; }
export function setCreationOrder(co: CreationOrder) { creationOrder = co; }
export function setEffectiveParentMap(ep: EffectiveParentMap) { effectiveParentMap = ep; }
export function setRootRows(rows: string[][]) { rootRows = rows; }
export function markRendered(uuid: string) { rendered[uuid] = true; }
export function isRendered(uuid: string): boolean { return !!rendered[uuid]; }

interface Config {
  collapsed?: string[];
  excluded?: string[];
  pinnedRoots?: string[];
  rootOrder?: Record<string, number>;
  rootRows?: string[][];
  ownershipOverrides?: Record<string, string>;
}

function applyConfig(cfg: Config): void {
  collapsedSet = new Set(cfg.collapsed || []);
  excludedClasses = new Set(cfg.excluded || []);
  pinnedRootClasses = new Set(cfg.pinnedRoots || []);
  rootOrder = cfg.rootOrder || {};
  rootRows = cfg.rootRows || [];
  ownershipOverrides = cfg.ownershipOverrides || {};
}

function clearState(): void {
  collapsedSet = new Set();
  excludedClasses = new Set();
  pinnedRootClasses = new Set();
  rootOrder = {};
  rootRows = [];
  ownershipOverrides = {};
}

export async function loadConfig(_tracePath: string): Promise<void> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      applyConfig(await res.json());
      return;
    }
  } catch {}
  clearState();
}

export function applyOwnershipOverrides(): void {
  if (!traceData) return;
  for (const [uuid, parent] of Object.entries(ownershipOverrides)) {
    if (traceData[uuid]) traceData[uuid].created_by = parent;
  }
}

export function saveConfig(): void {
  const cfg: Config = {
    collapsed: Array.from(collapsedSet),
    excluded: Array.from(excludedClasses),
    pinnedRoots: Array.from(pinnedRootClasses),
    rootOrder,
    rootRows,
    ownershipOverrides,
  };
  fetch("/save-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg, null, 2),
  }).catch(() => {});
}

export async function resetConfig(): Promise<void> {
  clearState();
  fetch("/delete-config", {
    method: "POST",
  }).catch(() => {});
}

export function saveLastTrace(tracePath: string): void {
  fetch("/save-last-trace", {
    method: "POST",
    body: tracePath,
  }).catch(() => {});
}

export async function getLastTrace(): Promise<string | null> {
  try {
    const res = await fetch("/get-last-trace", { cache: "no-store" });
    if (res.ok) return (await res.text()).trim() || null;
  } catch {}
  return null;
}
