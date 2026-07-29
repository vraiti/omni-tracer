import "./style.css";
import type { TraceData, FunctionData } from "./types";
import { renderTrace } from "./trace-render";
import { getClassName } from "./graph";

let traceData: TraceData | null = null;
let functionData: FunctionData | null = null;

interface FuncEntry {
  fid: string;
  label: string;
  descendantCount: number;
}

let funcIndex: FuncEntry[] = [];

const dropZone = document.getElementById("drop-zone")!;
const fileInputDrop = document.getElementById("file-input-drop") as HTMLInputElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const rootInput = document.getElementById("root-input") as HTMLInputElement;
const rootDropdown = document.getElementById("root-dropdown")!;
const rootList = document.getElementById("root-list")!;
const container = document.getElementById("trace-container")!;
const svgEl = document.getElementById("trace-edge-svg") as unknown as SVGSVGElement;
const loadingEl = document.getElementById("loading")!;
const controlsEl = document.getElementById("controls")!;
const statsEl = document.getElementById("stats")!;

function getFuncLabel(fn: { ref: string; bound_to?: string }): string {
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

function countDescendants(fid: string, functions: FunctionData): number {
  const seen = new Set<string>();
  const stack = [fid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const fn = functions[cur];
    if (fn) {
      for (const child of fn.invokes) stack.push(child);
    }
  }
  return seen.size - 1;
}

function buildIndex(functions: FunctionData): FuncEntry[] {
  const entries: FuncEntry[] = [];
  for (const [fid, fn] of Object.entries(functions)) {
    if (fn.invokes.length === 0) continue;
    entries.push({
      fid,
      label: getFuncLabel(fn),
      descendantCount: countDescendants(fid, functions),
    });
  }
  entries.sort((a, b) => b.descendantCount - a.descendantCount);
  return entries;
}

function showDropdown(filter: string): void {
  rootList.innerHTML = "";
  const lower = filter.toLowerCase();
  const matches = lower
    ? funcIndex.filter(e => e.label.toLowerCase().includes(lower))
    : funcIndex;
  const limited = matches.slice(0, 50);

  for (const entry of limited) {
    const row = document.createElement("div");
    row.className = "panel-row";
    row.innerHTML = `<span>${entry.label}</span> <span class="badge">${entry.descendantCount}</span>`;
    row.addEventListener("mousedown", e => {
      e.preventDefault();
      rootInput.value = entry.label;
      rootDropdown.classList.add("hidden");
      renderSelected(entry.fid);
    });
    rootList.appendChild(row);
  }

  if (limited.length < matches.length) {
    const more = document.createElement("div");
    more.className = "panel-row";
    more.style.color = "#666";
    more.textContent = `... ${matches.length - limited.length} more`;
    rootList.appendChild(more);
  }

  rootDropdown.classList.remove("hidden");
}

function loadTrace(raw: Record<string, unknown>, tracePath: string): void {
  traceData = (raw.objects || {}) as TraceData;
  functionData = (raw.functions || {}) as FunctionData;

  funcIndex = buildIndex(functionData);

  controlsEl.classList.remove("hidden");
  dropZone.style.display = "none";

  history.replaceState(null, "", "/trace/?trace=" + tracePath);

  statsEl.textContent = `${Object.keys(functionData).length} functions, ${Object.keys(traceData).length} objects`;
}

function renderSelected(fid: string): void {
  if (!functionData || !traceData) return;
  renderTrace(fid, functionData, traceData, container, svgEl);
}

let inputTimeout: ReturnType<typeof setTimeout> | null = null;
rootInput.addEventListener("input", () => {
  if (inputTimeout) clearTimeout(inputTimeout);
  inputTimeout = setTimeout(() => showDropdown(rootInput.value), 150);
});
rootInput.addEventListener("focus", () => showDropdown(rootInput.value));
rootInput.addEventListener("blur", () => {
  setTimeout(() => rootDropdown.classList.add("hidden"), 200);
});

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
