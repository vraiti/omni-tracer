import type { TraceData, FunctionData } from "./types";
import { setTraceData, setTraceFileName, setFunctionData, setObjectMethods, setFuncIndex, setRootFuncId, rootFuncId, loadConfig, applyOwnershipOverrides, saveLastTrace } from "./state";
import { buildAndRender } from "./render";
import { updateExcludeBtn, updatePinRootBtn, updateRootOrderBtn, updateCallChainBtn } from "./panels";
import { buildFuncIndex, buildObjectMethods } from "./functions";

let loadingEl: HTMLElement;

export function initLoader(): void {
  loadingEl = document.getElementById("loading")!;
}

async function applyTrace(raw: Record<string, unknown>, tracePath: string): Promise<void> {
  setTraceData((raw.objects || {}) as TraceData);
  const funcs = (raw.functions || {}) as FunctionData;
  setFunctionData(funcs);
  setFuncIndex(buildFuncIndex(funcs, (raw.objects || {}) as TraceData));
  await loadConfig(tracePath);
  if (rootFuncId && !funcs[rootFuncId]) {
    setRootFuncId(null);
  }
  setObjectMethods(buildObjectMethods(funcs, rootFuncId));
  applyOwnershipOverrides();
  updateExcludeBtn();
  updatePinRootBtn();
  updateRootOrderBtn();
  updateCallChainBtn();
  buildAndRender();
  history.replaceState(null, "", "/?trace=" + tracePath);
  saveLastTrace(tracePath);
}

export function loadFile(file: File): void {
  loadingEl.style.display = "flex";
  setTraceFileName(file.name);
  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(async () => {
      try {
        await applyTrace(JSON.parse(e.target!.result as string), "traces/" + file.name);
      } catch (err) {
        alert("Failed to parse JSON: " + (err as Error).message);
      }
      loadingEl.style.display = "none";
    }, 50);
  };
  reader.readAsText(file);
}

export function loadFromUrl(url: string): void {
  loadingEl.style.display = "flex";
  setTraceFileName(url.split("/").pop() || "unknown");
  fetch(url, { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(async raw => {
    await applyTrace(raw, url.replace(/^\//, ""));
    loadingEl.style.display = "none";
  }).catch(() => {
    loadingEl.style.display = "none";
    window.location.replace("/");
  });
}
