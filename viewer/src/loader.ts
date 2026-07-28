import type { TraceData } from "./types";
import { setTraceData, setTraceFileName, loadConfig } from "./state";
import { buildAndRender } from "./render";
import { updateExcludeBtn, updatePinRootBtn } from "./panels";

let loadingEl: HTMLElement;

export function initLoader(): void {
  loadingEl = document.getElementById("loading")!;
}

export function loadFile(file: File): void {
  loadingEl.style.display = "flex";
  setTraceFileName(file.name);
  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        const raw = JSON.parse(e.target!.result as string);
        setTraceData((raw.objects || {}) as TraceData);
        loadConfig();
        updateExcludeBtn();
        updatePinRootBtn();
        buildAndRender();
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
  fetch(url).then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(raw => {
    setTraceData((raw.objects || {}) as TraceData);
    loadConfig();
    updateExcludeBtn();
    updatePinRootBtn();
    buildAndRender();
    loadingEl.style.display = "none";
  }).catch(() => {
    loadingEl.style.display = "none";
    window.location.replace("/");
  });
}
