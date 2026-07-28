import {
  traceData, parentMap, effectiveParentMap, creationOrder, collapsedSet,
  excludedClasses, rootRows, setRendered, markRendered, isRendered,
  saveConfig, setRootRows,
  setParentMap, setCreationOrder, setEffectiveParentMap,
} from "./state";
import {
  getClassName, getOwned, getOwnedUuids,
  buildParentMap, buildCreationOrder, buildEffectiveParentMap,
  findRoots, canReach, isPinnedRoot, participatesInOwnership, clearReachCache,
} from "./graph";
import { scheduleEdgeLayout, highlightEdges, clearEdgeHighlights } from "./edges";

let hierarchyEl: HTMLElement;
let controlsEl: HTMLElement;
let dropZoneEl: HTMLElement;
let filterInputEl: HTMLInputElement;
let showIsolatedEl: HTMLInputElement;
let statsEl: HTMLElement;

export function initRender(): void {
  hierarchyEl = document.getElementById("hierarchy")!;
  controlsEl = document.getElementById("controls")!;
  dropZoneEl = document.getElementById("drop-zone")!;
  filterInputEl = document.getElementById("filter-input") as HTMLInputElement;
  showIsolatedEl = document.getElementById("show-isolated") as HTMLInputElement;
  statsEl = document.getElementById("stats")!;
}

export function buildAndRender(): void {
  if (!traceData) return;
  clearReachCache();
  setParentMap(buildParentMap(traceData));
  setCreationOrder(buildCreationOrder(traceData));
  setEffectiveParentMap(buildEffectiveParentMap(traceData, parentMap, creationOrder));
  render();
  dropZoneEl.classList.add("hidden");
  controlsEl.classList.remove("hidden");
  hierarchyEl.style.display = "block";
}

export function render(): void {
  if (!traceData) return;
  hierarchyEl.innerHTML = "";
  setRendered({});

  const filterText = filterInputEl.value.toLowerCase();
  const showIso = showIsolatedEl.checked;

  const totalObjects = Object.keys(traceData).length;
  const allRoots = findRoots(traceData, effectiveParentMap);

  const rootsByProc: Record<string, string[]> = {};
  for (const uuid of allRoots) {
    const proc = traceData[uuid].process || "unknown";
    if (!rootsByProc[proc]) rootsByProc[proc] = [];
    rootsByProc[proc].push(uuid);
  }

  for (const [proc, rootUuids] of Object.entries(rootsByProc)) {
    const procBox = document.createElement("div");
    procBox.className = "process-box";

    const label = document.createElement("div");
    label.className = "process-label";
    label.textContent = "process " + proc.substring(0, 12) + "...";
    procBox.appendChild(label);

    const children = document.createElement("div");
    children.className = "process-children";

    const rows = buildRows(rootUuids);

    let hasContent = false;
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      for (const uuid of rows[rowIdx]) {
        const el = renderObject(uuid, 0, new Set(), filterText, showIso);
        if (el) {
          el.dataset.row = String(rowIdx);
          children.appendChild(el);
          hasContent = true;
        }
      }
    }

    if (hasContent) {
      procBox.appendChild(children);
      hierarchyEl.appendChild(procBox);
      setupDragAndDrop(children);
    }
  }

  const totalShown = hierarchyEl.querySelectorAll(".obj-box:not(.hidden)").length;
  statsEl.textContent = totalShown + " / " + totalObjects + " objects shown";

  requestAnimationFrame(() => scheduleEdgeLayout());
}

function matchesFilter(uuid: string, filterText: string): boolean {
  if (!filterText) return true;
  if (!traceData) return false;
  const obj = traceData[uuid];
  if (!obj) return false;
  return getClassName(obj.ref).toLowerCase().includes(filterText);
}

function subtreeMatchesFilter(uuid: string, filterText: string, visited: Set<string>): boolean {
  if (!traceData) return false;
  if (visited.has(uuid)) return false;
  visited.add(uuid);
  if (matchesFilter(uuid, filterText)) return true;
  const obj = traceData[uuid];
  if (!obj) return false;
  for (const child of getOwnedUuids(obj)) {
    if (traceData[child] && subtreeMatchesFilter(child, filterText, visited)) return true;
  }
  return false;
}

function isExcluded(uuid: string): boolean {
  if (!traceData) return false;
  const obj = traceData[uuid];
  if (!obj) return false;
  return excludedClasses.has(getClassName(obj.ref));
}

function defaultSort(uuids: string[]): string[] {
  return uuids.slice().sort((a, b) => {
    const oa = getOwnedUuids(traceData![a]).length;
    const ob = getOwnedUuids(traceData![b]).length;
    return ob - oa;
  });
}

function buildRows(uuids: string[]): string[][] {
  if (rootRows.length === 0) return [defaultSort(uuids)];

  const available = new Set(uuids);
  const rows: string[][] = [];
  for (const savedRow of rootRows) {
    const row: string[] = [];
    for (const uuid of savedRow) {
      if (available.has(uuid)) {
        row.push(uuid);
        available.delete(uuid);
      }
    }
    if (row.length > 0) rows.push(row);
  }
  if (available.size > 0) {
    rows.push(defaultSort(Array.from(available)));
  }
  return rows;
}

function readCurrentRows(): string[][] {
  const rowMap: Record<string, string[]> = {};
  for (const container of hierarchyEl.querySelectorAll(".process-children")) {
    for (const box of container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>) {
      const uuid = box.dataset.uuid;
      const row = box.dataset.row || "0";
      if (!uuid) continue;
      if (!rowMap[row]) rowMap[row] = [];
      rowMap[row].push(uuid);
    }
  }
  const keys = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
  return keys.map(k => rowMap[String(k)]);
}

interface VisualRow {
  index: number;
  top: number;
  bottom: number;
  boxes: HTMLElement[];
}

function computeVisualRows(container: HTMLElement): VisualRow[] {
  const boxes = container.querySelectorAll(":scope > .obj-box:not(.dragging)") as NodeListOf<HTMLElement>;
  const byRow: Record<string, HTMLElement[]> = {};
  for (const box of boxes) {
    const row = box.dataset.row || "0";
    if (!byRow[row]) byRow[row] = [];
    byRow[row].push(box);
  }
  const indices = Object.keys(byRow).map(Number).sort((a, b) => a - b);
  return indices.map(idx => {
    const rowBoxes = byRow[String(idx)];
    let top = Infinity;
    let bottom = -Infinity;
    for (const box of rowBoxes) {
      const rect = box.getBoundingClientRect();
      if (rect.top < top) top = rect.top;
      if (rect.bottom > bottom) bottom = rect.bottom;
    }
    return { index: idx, top, bottom, boxes: rowBoxes };
  });
}

function setupDragAndDrop(container: HTMLElement): void {
  const boxes = container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>;
  for (const box of boxes) {
    box.draggable = true;
    box.addEventListener("dragstart", e => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", box.dataset.uuid || "");
      box.classList.add("dragging");
    });
    box.addEventListener("dragend", () => {
      box.classList.remove("dragging");
      clearDropIndicators(container);
    });
  }

  container.addEventListener("dragover", e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropIndicators(container);
    const drop = getDropPosition(container, e.clientX, e.clientY);
    if (drop.type === "in-row" && drop.target) {
      drop.target.classList.add("drop-left");
    } else if (drop.type === "new-row") {
      if (drop.belowRow !== null) {
        const vrows = computeVisualRows(container);
        const vrow = vrows.find(r => r.index === drop.belowRow);
        if (vrow && vrow.boxes.length > 0) {
          vrow.boxes[0].classList.add("drop-row-below");
        }
      } else {
        container.classList.add("drop-end");
      }
    }
  });

  container.addEventListener("dragleave", e => {
    if (!container.contains(e.relatedTarget as Node)) {
      clearDropIndicators(container);
    }
  });

  container.addEventListener("drop", e => {
    e.preventDefault();
    clearDropIndicators(container);
    const uuid = e.dataTransfer?.getData("text/plain");
    if (!uuid) return;
    const dragged = container.querySelector(`.obj-box[data-uuid="${uuid}"]`) as HTMLElement | null;
    if (!dragged) return;
    const drop = getDropPosition(container, e.clientX, e.clientY);
    if (drop.type === "in-row") {
      dragged.dataset.row = String(drop.rowIndex);
    } else {
      const newRowIdx = drop.belowRow !== null ? drop.belowRow + 1 : getMaxRow(container) + 1;
      bumpRows(container, newRowIdx);
      dragged.dataset.row = String(newRowIdx);
    }
    setRootRows(readCurrentRows());
    compactRows(container);
    setRootRows(readCurrentRows());
    saveConfig();
    scheduleEdgeLayout();
  });
}

function getMaxRow(container: HTMLElement): number {
  let max = -1;
  for (const box of container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>) {
    const r = parseInt(box.dataset.row || "0", 10);
    if (r > max) max = r;
  }
  return max;
}

function bumpRows(container: HTMLElement, fromRow: number): void {
  for (const box of container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>) {
    const r = parseInt(box.dataset.row || "0", 10);
    if (r >= fromRow) box.dataset.row = String(r + 1);
  }
}

function compactRows(container: HTMLElement): void {
  const boxes = container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>;
  const usedRows = new Set<number>();
  for (const box of boxes) usedRows.add(parseInt(box.dataset.row || "0", 10));
  const sorted = Array.from(usedRows).sort((a, b) => a - b);
  const remap: Record<number, number> = {};
  sorted.forEach((old, i) => { remap[old] = i; });
  for (const box of boxes) {
    const old = parseInt(box.dataset.row || "0", 10);
    box.dataset.row = String(remap[old]);
  }
}

const ROW_EDGE_ZONE = 16;

type DropPosition =
  | { type: "in-row"; rowIndex: number; target: HTMLElement | null }
  | { type: "new-row"; belowRow: number | null };

function getDropPosition(container: HTMLElement, clientX: number, clientY: number): DropPosition {
  const vrows = computeVisualRows(container);
  if (vrows.length === 0) return { type: "new-row", belowRow: null };

  for (let i = 0; i < vrows.length; i++) {
    const vrow = vrows[i];
    if (clientY < vrow.top) {
      const prevIdx = i > 0 ? vrows[i - 1].index : null;
      return { type: "new-row", belowRow: prevIdx };
    }
    if (clientY < vrow.top + ROW_EDGE_ZONE && i > 0) {
      return { type: "new-row", belowRow: vrows[i - 1].index };
    }
    if (clientY > vrow.bottom - ROW_EDGE_ZONE && clientY <= vrow.bottom) {
      return { type: "new-row", belowRow: vrow.index };
    }
    if (clientY >= vrow.top && clientY <= vrow.bottom) {
      for (const box of vrow.boxes) {
        const br = box.getBoundingClientRect();
        if (clientX < br.left + br.width / 2) {
          return { type: "in-row", rowIndex: vrow.index, target: box };
        }
      }
      return { type: "in-row", rowIndex: vrow.index, target: null };
    }
  }
  return { type: "new-row", belowRow: vrows[vrows.length - 1].index };
}

function clearDropIndicators(container: HTMLElement): void {
  container.classList.remove("drop-end");
  for (const el of container.querySelectorAll(".drop-left, .drop-row-below")) {
    el.classList.remove("drop-left", "drop-row-below");
  }
}

function highlightGroup(uuid: string): void {
  for (const el of hierarchyEl.querySelectorAll(`.obj-ref[data-ref-target="${uuid}"]`)) {
    el.classList.add("group-highlight");
  }
  const box = hierarchyEl.querySelector(`.obj-box[data-uuid="${uuid}"]`);
  if (box) box.classList.add("group-highlight");
  highlightEdges(uuid);
}

function clearGroupHighlight(): void {
  for (const el of hierarchyEl.querySelectorAll(".group-highlight")) {
    el.classList.remove("group-highlight");
  }
  clearEdgeHighlights();
}

function rehighlightParent(el: HTMLElement, _e: MouseEvent): void {
  const parentBox = el.parentElement?.closest(".obj-box") as HTMLElement | null;
  if (!parentBox) return;
  const parentUuid = parentBox.dataset.uuid;
  if (!parentUuid) return;
  highlightGroup(parentUuid);
}

function toggleCollapse(uuid: string, box: HTMLElement): void {
  if (collapsedSet.has(uuid)) {
    collapsedSet.delete(uuid);
    box.classList.remove("collapsed");
  } else {
    collapsedSet.add(uuid);
    box.classList.add("collapsed");
  }
  saveConfig();
  scheduleEdgeLayout();
}

function renderObject(
  uuid: string,
  depth: number,
  visited: Set<string>,
  filterText: string,
  showIso: boolean,
  attrName?: string,
  skipOwned?: string,
): HTMLElement | null {
  if (!traceData) return null;
  const obj = traceData[uuid];
  if (!obj) return null;

  if (isExcluded(uuid)) return null;
  if (!showIso && !participatesInOwnership(uuid, traceData, parentMap)) return null;

  if (visited.has(uuid)) {
    if (!subtreeMatchesFilter(uuid, filterText, new Set())) return null;
    return renderRef(uuid, attrName);
  }

  if (isRendered(uuid)) {
    if (!subtreeMatchesFilter(uuid, filterText, new Set())) return null;
    return renderRef(uuid, attrName);
  }

  if (!subtreeMatchesFilter(uuid, filterText, new Set(visited))) return null;

  visited.add(uuid);
  markRendered(uuid);

  const box = document.createElement("div");
  box.className = "obj-box depth-" + (depth % 7);
  box.dataset.uuid = uuid;
  box.dataset.ref = obj.ref;

  const label = document.createElement("div");
  label.className = "obj-label";
  const className = getClassName(obj.ref);
  if (attrName) {
    const nameSpan = document.createElement("span");
    nameSpan.className = "obj-label-attr";
    nameSpan.textContent = attrName;
    const classSpan = document.createElement("span");
    classSpan.className = "obj-label-class";
    classSpan.textContent = className;
    label.appendChild(nameSpan);
    label.appendChild(classSpan);
  } else {
    label.textContent = className;
  }
  box.appendChild(label);

  if (collapsedSet.has(uuid)) box.classList.add("collapsed");

  label.addEventListener("click", e => {
    e.stopPropagation();
    toggleCollapse(uuid, box);
  });

  box.addEventListener("mouseenter", e => {
    e.stopPropagation();
    clearGroupHighlight();
    highlightGroup(uuid);
  });
  box.addEventListener("mouseleave", e => {
    e.stopPropagation();
    clearGroupHighlight();
    rehighlightParent(box, e);
  });

  const ownedEntries = getOwned(obj).filter(([c]) => c !== skipOwned);
  if (ownedEntries.length > 0) {
    const childrenDiv = document.createElement("div");
    childrenDiv.className = "obj-children";

    const sortedOwns = ownedEntries.slice().sort((a, b) => {
      const oa = traceData![a[0]] ? getOwnedUuids(traceData![a[0]]).length : 0;
      const ob = traceData![b[0]] ? getOwnedUuids(traceData![b[0]]).length : 0;
      return ob - oa;
    });

    let hasVisibleChild = false;
    for (const [child, childAttr] of sortedOwns) {
      let el: HTMLElement | null;
      const childEffParents = effectiveParentMap[child];
      if (isPinnedRoot(child) || (childEffParents && childEffParents.length > 0 && !childEffParents.includes(uuid))) {
        if (!subtreeMatchesFilter(child, filterText, new Set())) continue;
        el = renderRef(child, childAttr);
      } else if (traceData[child] && canReach(traceData, child, uuid, new Set())) {
        const childOwns = traceData[child].owns;
        const ownsMap = Array.isArray(childOwns) ? {} as Record<string, string> : (childOwns || {});
        if (uuid in ownsMap) {
          el = renderObject(child, depth + 1, new Set(visited), filterText, showIso, childAttr, uuid);
        } else {
          if (!subtreeMatchesFilter(child, filterText, new Set())) continue;
          el = renderRef(child, childAttr);
        }
      } else {
        el = renderObject(child, depth + 1, new Set(visited), filterText, showIso, childAttr);
      }
      if (el) {
        childrenDiv.appendChild(el);
        hasVisibleChild = true;
      }
    }

    if (hasVisibleChild) {
      box.appendChild(childrenDiv);
    }
  }

  return box;
}

function renderRef(uuid: string, attrName?: string): HTMLElement | null {
  if (!traceData) return null;
  const obj = traceData[uuid];
  if (!obj) return null;
  if (isExcluded(uuid)) return null;

  const el = document.createElement("div");
  el.className = "obj-ref";
  el.textContent = (attrName || getClassName(obj.ref)) + " ⇗";
  el.dataset.uuid = uuid;
  el.dataset.refTarget = uuid;

  el.addEventListener("mouseenter", e => {
    e.stopPropagation();
    clearGroupHighlight();
    highlightGroup(uuid);
  });
  el.addEventListener("mouseleave", e => {
    e.stopPropagation();
    clearGroupHighlight();
    rehighlightParent(el, e);
  });

  el.addEventListener("click", () => {
    const target = hierarchyEl.querySelector(`.obj-box[data-uuid="${uuid}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      (target as HTMLElement).style.outline = "2px solid #5a9";
      setTimeout(() => (target as HTMLElement).style.outline = "", 1500);
    }
  });

  return el;
}
