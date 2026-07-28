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

export function setTraceData(data: TraceData) { traceData = data; }
export function setTraceFileName(name: string) { traceFileName = name; }
export function setParentMap(pm: ParentMap) { parentMap = pm; }
export function setRendered(r: Record<string, boolean>) { rendered = r; }
export function setCreationOrder(co: CreationOrder) { creationOrder = co; }
export function setEffectiveParentMap(ep: EffectiveParentMap) { effectiveParentMap = ep; }
export function markRendered(uuid: string) { rendered[uuid] = true; }
export function isRendered(uuid: string): boolean { return !!rendered[uuid]; }

function configKey(): string {
  return "omni-tracer:" + (traceFileName || "unknown");
}

export function loadConfig(): void {
  try {
    const raw = localStorage.getItem(configKey());
    if (raw) {
      const cfg = JSON.parse(raw);
      collapsedSet = new Set(cfg.collapsed || []);
      excludedClasses = new Set(cfg.excluded || []);
      pinnedRootClasses = new Set(cfg.pinnedRoots || []);
    } else {
      collapsedSet = new Set();
      excludedClasses = new Set();
      pinnedRootClasses = new Set();
    }
  } catch {
    collapsedSet = new Set();
    excludedClasses = new Set();
    pinnedRootClasses = new Set();
  }
}

export function saveConfig(): void {
  try {
    localStorage.setItem(configKey(), JSON.stringify({
      collapsed: Array.from(collapsedSet),
      excluded: Array.from(excludedClasses),
      pinnedRoots: Array.from(pinnedRootClasses),
    }));
  } catch { /* quota exceeded or private browsing */ }
}
