import "./style.css";
import type { TraceData, FunctionData } from "./types";
import { renderTrace, findRootCandidates } from "./trace-render";
import { getClassName } from "./graph";

let traceData: TraceData | null = null;
let functionData: FunctionData | null = null;

const dropZone = document.getElementById("drop-zone")!;
const fileInputDrop = document.getElementById("file-input-drop") as HTMLInputElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const rootSelect = document.getElementById("root-select") as HTMLSelectElement;
const container = document.getElementById("trace-container")!;
const svgEl = document.getElementById("trace-edge-svg") as unknown as SVGSVGElement;
const loadingEl = document.getElementById("loading")!;
const controlsEl = document.getElementById("controls")!;
const statsEl = document.getElementById("stats")!;

function getFuncLabel(_fid: string, fn: { ref: string; bound_to?: string }): string {
  const ref = fn.ref;
  const name = ref.includes(":") ? ref.split(":").pop()! : ref;
  if (fn.bound_to && traceData && traceData[fn.bound_to]) {
    const cls = getClassName(traceData[fn.bound_to].ref);
    const shortCls = cls.includes(".") ? cls.split(".").pop()! : cls;
    return shortCls + "." + name;
  }
  const file = ref.includes("/") ? ref.split(":")[0].split("/").pop()! : "";
  return file ? file + ":" + name : name;
}

function loadTrace(raw: Record<string, unknown>, tracePath: string): void {
  traceData = (raw.objects || {}) as TraceData;
  functionData = (raw.functions || {}) as FunctionData;

  const roots = findRootCandidates(functionData);

  rootSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `-- select root (${roots.length} candidates) --`;
  rootSelect.appendChild(placeholder);

  for (const fid of roots) {
    const fn = functionData[fid];
    if (!fn) continue;
    const opt = document.createElement("option");
    opt.value = fid;
    opt.textContent = getFuncLabel(fid, fn);
    rootSelect.appendChild(opt);
  }

  controlsEl.classList.remove("hidden");
  dropZone.style.display = "none";

  history.replaceState(null, "", "/trace/?trace=" + tracePath);

  statsEl.textContent = `${Object.keys(functionData).length} functions, ${Object.keys(traceData).length} objects`;
}

function renderSelected(): void {
  const fid = rootSelect.value;
  if (!fid || !functionData || !traceData) return;
  renderTrace(fid, functionData, traceData, container, svgEl);
}

rootSelect.addEventListener("change", renderSelected);

function loadFile(file: File): void {
  loadingEl.style.display = "flex";
  const reader = new FileReader();
  reader.onload = e => {
    setTimeout(() => {
      try {
        loadTrace(JSON.parse(e.target!.result as string), "traces/" + file.name);
      } catch (err) {
        alert("Failed to parse: " + (err as Error).message);
      }
      loadingEl.style.display = "none";
    }, 50);
  };
  reader.readAsText(file);
}

function loadFromUrl(url: string): void {
  loadingEl.style.display = "flex";
  fetch(url, { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(raw => {
    loadTrace(raw, url.replace(/^\//, ""));
    loadingEl.style.display = "none";
  }).catch(() => {
    loadingEl.style.display = "none";
  });
}

dropZone.addEventListener("click", () => fileInputDrop.click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer?.files.length) loadFile(e.dataTransfer.files[0]);
});
fileInputDrop.addEventListener("change", () => { if (fileInputDrop.files?.length) loadFile(fileInputDrop.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files?.length) loadFile(fileInput.files[0]); });

const traceParam = new URLSearchParams(window.location.search).get("trace");
if (traceParam) {
  loadFromUrl("/" + traceParam);
}
