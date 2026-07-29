import { traceData, excludedClasses, pinnedRootClasses, rootOrder, functionData, rootFuncId, funcIndex, setRootFuncId, setObjectMethods, saveConfig } from "./state";
import { getClassName } from "./graph";
import { render, buildAndRender } from "./render";
import { buildObjectMethods, getFuncName } from "./functions";

let excludeBtn: HTMLElement;
let excludePanel: HTMLElement;
let excludeFilter: HTMLInputElement;
let excludeList: HTMLElement;
let pinRootBtn: HTMLElement;
let pinRootPanel: HTMLElement;
let pinRootFilter: HTMLInputElement;
let pinRootList: HTMLElement;
let rootOrderBtn: HTMLElement;
let rootOrderPanel: HTMLElement;
let rootOrderFilter: HTMLInputElement;
let rootOrderList: HTMLElement;
let callChainBtn: HTMLElement;
let callChainPanel: HTMLElement;
let callChainFilter: HTMLInputElement;
let callChainList: HTMLElement;

export function initPanels(): void {
  excludeBtn = document.getElementById("exclude-btn")!;
  excludePanel = document.getElementById("exclude-panel")!;
  excludeFilter = document.getElementById("exclude-filter") as HTMLInputElement;
  excludeList = document.getElementById("exclude-list")!;
  pinRootBtn = document.getElementById("pin-root-btn")!;
  pinRootPanel = document.getElementById("pin-root-panel")!;
  pinRootFilter = document.getElementById("pin-root-filter") as HTMLInputElement;
  pinRootList = document.getElementById("pin-root-list")!;
  rootOrderBtn = document.getElementById("root-order-btn")!;
  rootOrderPanel = document.getElementById("root-order-panel")!;
  rootOrderFilter = document.getElementById("root-order-filter") as HTMLInputElement;
  rootOrderList = document.getElementById("root-order-list")!;
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
    if (!rootOrderPanel.contains(e.target as Node) && e.target !== rootOrderBtn) {
      rootOrderPanel.classList.add("hidden");
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

  rootOrderBtn.addEventListener("click", e => {
    e.stopPropagation();
    rootOrderPanel.classList.toggle("hidden");
    if (!rootOrderPanel.classList.contains("hidden")) {
      populateRootOrderPanel();
      rootOrderFilter.focus();
    }
  });

  rootOrderFilter.addEventListener("click", e => e.stopPropagation());
  rootOrderFilter.addEventListener("input", () => populateRootOrderPanel());

  callChainBtn = document.getElementById("call-chain-btn")!;
  callChainPanel = document.getElementById("call-chain-panel")!;
  callChainFilter = document.getElementById("call-chain-filter") as HTMLInputElement;
  callChainList = document.getElementById("call-chain-list")!;

  callChainBtn.addEventListener("click", e => {
    e.stopPropagation();
    callChainPanel.classList.toggle("hidden");
    if (!callChainPanel.classList.contains("hidden")) {
      populateCallChainPanel();
      callChainFilter.focus();
    }
  });

  callChainFilter.addEventListener("click", e => e.stopPropagation());
  callChainFilter.addEventListener("input", () => populateCallChainPanel());

  document.addEventListener("click", e => {
    if (!callChainPanel.contains(e.target as Node) && e.target !== callChainBtn) {
      callChainPanel.classList.add("hidden");
    }
  });
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
    .sort((a, b) => {
      const aSelected = selectedSet.has(a[0]) ? 0 : 1;
      const bSelected = selectedSet.has(b[0]) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a[0].localeCompare(b[0]);
    });

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

export function updateRootOrderBtn(): void {
  const n = Object.keys(rootOrder).length;
  rootOrderBtn.textContent = n > 0 ? `Root order (${n}) ▾` : "Root order ▾";
}

function getRootClassCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const el of document.querySelectorAll(".process-children > .obj-box") as NodeListOf<HTMLElement>) {
    const ref = el.dataset.ref;
    if (!ref) continue;
    const name = getClassName(ref);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function populateRootOrderPanel(): void {
  const counts = getRootClassCounts();
  const search = rootOrderFilter.value.toLowerCase();
  const sorted = Object.entries(counts)
    .filter(([name]) => !excludedClasses.has(name))
    .filter(([name]) => !search || name.toLowerCase().includes(search))
    .sort((a, b) => {
      const aRanked = a[0] in rootOrder ? 0 : 1;
      const bRanked = b[0] in rootOrder ? 0 : 1;
      if (aRanked !== bRanked) return aRanked - bRanked;
      if (aRanked === 0) return (rootOrder[a[0]] ?? 0) - (rootOrder[b[0]] ?? 0);
      return a[0].localeCompare(b[0]);
    });

  rootOrderList.innerHTML = "";
  for (const [name, count] of sorted) {
    const row = document.createElement("label");
    row.className = "panel-row";

    const input = document.createElement("input");
    input.type = "number";
    input.style.width = "48px";
    input.style.marginRight = "6px";
    input.min = "0";
    if (name in rootOrder) {
      input.value = String(rootOrder[name]);
    } else {
      input.value = "";
      input.placeholder = "-";
    }
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("change", () => {
      const val = input.value.trim();
      if (val === "") {
        delete rootOrder[name];
      } else {
        rootOrder[name] = parseInt(val, 10) || 0;
      }
      saveConfig();
      updateRootOrderBtn();
      buildAndRender();
    });

    const text = document.createElement("span");
    text.textContent = name;
    text.style.flex = "1";

    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.className = "badge";

    row.appendChild(input);
    row.appendChild(text);
    row.appendChild(badge);
    rootOrderList.appendChild(row);
  }
}

export function updateCallChainBtn(): void {
  if (rootFuncId && functionData?.[rootFuncId]) {
    const name = getFuncName(functionData[rootFuncId].ref);
    callChainBtn.textContent = `Call chain: ${name} ▾`;
  } else {
    callChainBtn.textContent = "Call chain ▾";
  }
}

function selectCallChain(fid: string | null): void {
  setRootFuncId(fid);
  if (functionData) {
    setObjectMethods(buildObjectMethods(functionData, fid));
  }
  saveConfig();
  updateCallChainBtn();
  callChainPanel.classList.add("hidden");
  buildAndRender();
}

function populateCallChainPanel(): void {
  const index = funcIndex;
  const search = callChainFilter.value.toLowerCase();
  const filtered = search
    ? index.filter(e => e.label.toLowerCase().includes(search))
    : index;
  const limited = filtered.slice(0, 100);

  callChainList.innerHTML = "";

  for (const entry of limited) {
    const row = document.createElement("div");
    row.className = "panel-row";
    if (entry.fid === rootFuncId) row.style.color = "#5a9";

    const text = document.createElement("span");
    text.textContent = entry.label;
    text.style.flex = "1";

    const badge = document.createElement("span");
    badge.textContent = String(entry.descendantCount);
    badge.className = "badge";

    row.appendChild(text);
    row.appendChild(badge);
    row.addEventListener("click", () => selectCallChain(entry.fid));
    callChainList.appendChild(row);
  }

  if (limited.length < filtered.length) {
    const more = document.createElement("div");
    more.className = "panel-row";
    more.style.color = "#666";
    more.textContent = `... ${filtered.length - limited.length} more`;
    callChainList.appendChild(more);
  }
}

