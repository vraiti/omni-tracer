import { traceData, excludedClasses, pinnedRootClasses, saveConfig } from "./state";
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

export function initPanels(): void {
  excludeBtn = document.getElementById("exclude-btn")!;
  excludePanel = document.getElementById("exclude-panel")!;
  excludeFilter = document.getElementById("exclude-filter") as HTMLInputElement;
  excludeList = document.getElementById("exclude-list")!;
  pinRootBtn = document.getElementById("pin-root-btn")!;
  pinRootPanel = document.getElementById("pin-root-panel")!;
  pinRootFilter = document.getElementById("pin-root-filter") as HTMLInputElement;
  pinRootList = document.getElementById("pin-root-list")!;

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

function populateExcludePanel(): void {
  const counts = getClassCounts();
  const search = excludeFilter.value.toLowerCase();
  const sorted = Object.entries(counts)
    .filter(([name]) => !search || name.toLowerCase().includes(search))
    .sort((a, b) => a[0].localeCompare(b[0]));

  excludeList.innerHTML = "";
  for (const [name, count] of sorted) {
    const row = document.createElement("label");
    row.className = "panel-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = excludedClasses.has(name);
    cb.style.accentColor = "#c55";
    cb.addEventListener("change", () => {
      if (cb.checked) excludedClasses.add(name);
      else excludedClasses.delete(name);
      saveConfig();
      updateExcludeBtn();
      render();
    });

    const text = document.createElement("span");
    text.textContent = name;
    text.style.flex = "1";

    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.className = "badge";

    row.appendChild(cb);
    row.appendChild(text);
    row.appendChild(badge);
    excludeList.appendChild(row);
  }
}

export function updatePinRootBtn(): void {
  const n = pinnedRootClasses.size;
  pinRootBtn.textContent = n > 0 ? `Roots (${n}) ▾` : "Roots ▾";
}

function populatePinRootPanel(): void {
  const counts = getClassCounts();
  const search = pinRootFilter.value.toLowerCase();
  const sorted = Object.entries(counts)
    .filter(([name]) => !search || name.toLowerCase().includes(search))
    .sort((a, b) => a[0].localeCompare(b[0]));

  pinRootList.innerHTML = "";
  for (const [name, count] of sorted) {
    const row = document.createElement("label");
    row.className = "panel-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pinnedRootClasses.has(name);
    cb.style.accentColor = "#59a";
    cb.addEventListener("change", () => {
      if (cb.checked) pinnedRootClasses.add(name);
      else pinnedRootClasses.delete(name);
      saveConfig();
      updatePinRootBtn();
      buildAndRender();
    });

    const text = document.createElement("span");
    text.textContent = name;
    text.style.flex = "1";

    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.className = "badge";

    row.appendChild(cb);
    row.appendChild(text);
    row.appendChild(badge);
    pinRootList.appendChild(row);
  }
}
