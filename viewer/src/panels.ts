import { traceData, excludedClasses, pinnedRootClasses, entrypointClasses, saveConfig } from "./state";
import { getClassName } from "./graph";
import { render, buildAndRender } from "./render";

let excludeBtn: HTMLElement;
let excludePanel: HTMLElement;
let excludeFilter: HTMLInputElement;
let excludeList: HTMLElement;
let pinRootBtn: HTMLElement;
let pinRootPanel: HTMLElement;
let pinRootFilter: HTMLInputElement;
let pinRootList: HTMLElement;
let entrypointBtn: HTMLElement;
let entrypointPanel: HTMLElement;
let entrypointFilter: HTMLInputElement;
let entrypointList: HTMLElement;

export function initPanels(): void {
  excludeBtn = document.getElementById("exclude-btn")!;
  excludePanel = document.getElementById("exclude-panel")!;
  excludeFilter = document.getElementById("exclude-filter") as HTMLInputElement;
  excludeList = document.getElementById("exclude-list")!;
  pinRootBtn = document.getElementById("pin-root-btn")!;
  pinRootPanel = document.getElementById("pin-root-panel")!;
  pinRootFilter = document.getElementById("pin-root-filter") as HTMLInputElement;
  pinRootList = document.getElementById("pin-root-list")!;
  entrypointBtn = document.getElementById("entrypoint-btn")!;
  entrypointPanel = document.getElementById("entrypoint-panel")!;
  entrypointFilter = document.getElementById("entrypoint-filter") as HTMLInputElement;
  entrypointList = document.getElementById("entrypoint-list")!;

  excludeBtn.addEventListener("click", e => {
    e.stopPropagation();
    excludePanel.classList.toggle("hidden");
    if (!excludePanel.classList.contains("hidden")) {
      populateExcludePanel();
      excludeFilter.focus();
    }
  });

  document.addEventListener("click", e => {
    if (!excludePanel.contains(e.target as Node) && e.target !== excludeBtn) {
      excludePanel.classList.add("hidden");
    }
    if (!pinRootPanel.contains(e.target as Node) && e.target !== pinRootBtn) {
      pinRootPanel.classList.add("hidden");
    }
    if (!entrypointPanel.contains(e.target as Node) && e.target !== entrypointBtn) {
      entrypointPanel.classList.add("hidden");
    }
  });

  excludeFilter.addEventListener("click", e => e.stopPropagation());
  excludeFilter.addEventListener("input", () => populateExcludePanel());

  pinRootBtn.addEventListener("click", e => {
    e.stopPropagation();
    pinRootPanel.classList.toggle("hidden");
    if (!pinRootPanel.classList.contains("hidden")) {
      populatePinRootPanel();
      pinRootFilter.focus();
    }
  });

  pinRootFilter.addEventListener("click", e => e.stopPropagation());
  pinRootFilter.addEventListener("input", () => populatePinRootPanel());

  entrypointBtn.addEventListener("click", e => {
    e.stopPropagation();
    entrypointPanel.classList.toggle("hidden");
    if (!entrypointPanel.classList.contains("hidden")) {
      populateEntrypointPanel();
      entrypointFilter.focus();
    }
  });

  entrypointFilter.addEventListener("click", e => e.stopPropagation());
  entrypointFilter.addEventListener("input", () => populateEntrypointPanel());
}

function getClassCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const obj of Object.values(traceData || {})) {
    const name = getClassName(obj.ref);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

export function updateExcludeBtn(): void {
  const n = excludedClasses.size;
  excludeBtn.textContent = n > 0 ? `Exclude classes (${n}) ▾` : "Exclude classes ▾";
}

function populatePanel(
  filterEl: HTMLInputElement,
  listEl: HTMLElement,
  selectedSet: Set<string>,
  accentColor: string,
  onChange: (name: string, checked: boolean) => void,
  counts?: Record<string, number>,
): void {
  if (!counts) counts = getClassCounts();
  const search = filterEl.value.toLowerCase();
  const sorted = Object.entries(counts)
    .filter(([name]) => !search || name.toLowerCase().includes(search))
    .sort((a, b) => a[0].localeCompare(b[0]));

  listEl.innerHTML = "";
  for (const [name, count] of sorted) {
    const row = document.createElement("label");
    row.className = "panel-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedSet.has(name);
    cb.style.accentColor = accentColor;
    cb.addEventListener("change", () => onChange(name, cb.checked));

    const text = document.createElement("span");
    text.textContent = name;
    text.style.flex = "1";

    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.className = "badge";

    row.appendChild(cb);
    row.appendChild(text);
    row.appendChild(badge);
    listEl.appendChild(row);
  }
}

function populateExcludePanel(): void {
  populatePanel(excludeFilter, excludeList, excludedClasses, "#c55", (name, checked) => {
    if (checked) excludedClasses.add(name);
    else excludedClasses.delete(name);
    saveConfig();
    updateExcludeBtn();
    render();
  });
}

export function updatePinRootBtn(): void {
  const n = pinnedRootClasses.size;
  pinRootBtn.textContent = n > 0 ? `Roots (${n}) ▾` : "Roots ▾";
}

function populatePinRootPanel(): void {
  populatePanel(pinRootFilter, pinRootList, pinnedRootClasses, "#59a", (name, checked) => {
    if (checked) pinnedRootClasses.add(name);
    else pinnedRootClasses.delete(name);
    saveConfig();
    updatePinRootBtn();
    buildAndRender();
  });
}

export function updateEntrypointBtn(): void {
  const n = entrypointClasses.size;
  entrypointBtn.textContent = n > 0 ? `Entrypoints (${n}) ▾` : "Entrypoints ▾";
}

function getRenderedRootClassCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  const roots = document.querySelectorAll(".process-children > .obj-box") as NodeListOf<HTMLElement>;
  for (const root of roots) {
    const ref = root.dataset.ref;
    if (!ref) continue;
    const name = getClassName(ref);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function populateEntrypointPanel(): void {
  populatePanel(entrypointFilter, entrypointList, entrypointClasses, "#5a9", (name, checked) => {
    if (checked) entrypointClasses.add(name);
    else entrypointClasses.delete(name);
    saveConfig();
    updateEntrypointBtn();
    buildAndRender();
  }, getRenderedRootClassCounts());
}
