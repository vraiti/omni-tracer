import type { TraceData, ParentMap, CreationOrder, EffectiveParentMap } from "./types";

export let traceData: TraceData | null = null;
export let traceFileName: string | null = null;
export let parentMap: ParentMap = {};
export let rendered: Record<string, boolean> = {};
export let collapsedSet = new Set<string>();
export let excludedClasses = new Set<string>();
export let pinnedRootClasses = new Set<string>();
export let entrypointClasses = new Set<string>();
export let creationOrder: CreationOrder = {};
export let effectiveParentMap: EffectiveParentMap = {};
export let rootRows: string[][] = [];

let currentTracePath: string | null = null;

export function setTraceData(data: TraceData) { traceData = data; }
export function setTraceFileName(name: string) { traceFileName = name; }
export function setParentMap(pm: ParentMap) { parentMap = pm; }
export function setRendered(r: Record<string, boolean>) { rendered = r; }
export function setCreationOrder(co: CreationOrder) { creationOrder = co; }
export function setEffectiveParentMap(ep: EffectiveParentMap) { effectiveParentMap = ep; }
export function setRootRows(rows: string[][]) { rootRows = rows; }
export function setEntrypointClasses(s: Set<string>) { entrypointClasses = s; }
export function markRendered(uuid: string) { rendered[uuid] = true; }
export function isRendered(uuid: string): boolean { return !!rendered[uuid]; }

interface Config {
  collapsed?: string[];
  excluded?: string[];
  pinnedRoots?: string[];
  entrypoints?: string[];
  rootRows?: string[][];
}

function applyConfig(cfg: Config): void {
  collapsedSet = new Set(cfg.collapsed || []);
  excludedClasses = new Set(cfg.excluded || []);
  pinnedRootClasses = new Set(cfg.pinnedRoots || []);
  entrypointClasses = new Set(cfg.entrypoints || []);
  rootRows = cfg.rootRows || [];
}

function clearState(): void {
  collapsedSet = new Set();
  excludedClasses = new Set();
  pinnedRootClasses = new Set();
  entrypointClasses = new Set();
  rootRows = [];
}

export async function loadConfig(tracePath: string): Promise<void> {
  currentTracePath = tracePath;
  try {
    const res = await fetch("/" + tracePath + ".config.json", { cache: "no-store" });
    if (res.ok) {
      applyConfig(await res.json());
      return;
    }
  } catch {}
  clearState();
}

export function saveConfig(): void {
  if (!currentTracePath) return;
  const cfg: Config = {
    collapsed: Array.from(collapsedSet),
    excluded: Array.from(excludedClasses),
    pinnedRoots: Array.from(pinnedRootClasses),
    entrypoints: Array.from(entrypointClasses),
    rootRows,
  };
  fetch("/save-config?trace=" + encodeURIComponent(currentTracePath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg, null, 2),
  }).catch(() => {});
}

export async function resetConfig(): Promise<void> {
  clearState();
  if (!currentTracePath) return;
  fetch("/delete-config?trace=" + encodeURIComponent(currentTracePath), {
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
