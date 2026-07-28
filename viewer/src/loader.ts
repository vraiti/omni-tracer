import type { TraceData } from "./types";
import { setTraceData, setTraceFileName, loadConfig, saveLastTrace } from "./state";
import { buildAndRender } from "./render";
import { updateExcludeBtn, updatePinRootBtn, updateEntrypointBtn } from "./panels";

let loadingEl: HTMLElement;

export function initLoader(): void {
  loadingEl = document.getElementById("loading")!;
}

function applyTrace(raw: Record<string, unknown>, tracePath: string): void {
  setTraceData((raw.objects || {}) as TraceData);
  loadConfig();
  updateExcludeBtn();
  updatePinRootBtn();
  updateEntrypointBtn();
  buildAndRender();
  history.replaceState(null, "", "/?trace=" + tracePath);
  saveLastTrace(tracePath);
}

export function loadFile(file: File): void {
  loadingEl.style.display = "flex";
  setTraceFileName(file.name);
  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        applyTrace(JSON.parse(e.target!.result as string), "traces/" + file.name);
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
  }).then(raw => {
    applyTrace(raw, url.replace(/^\//, ""));
    loadingEl.style.display = "none";
  }).catch(() => {
    loadingEl.style.display = "none";
    window.location.replace("/");
  });
}
