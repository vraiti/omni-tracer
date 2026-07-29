import {
  traceData, parentMap, effectiveParentMap, creationOrder, collapsedSet,
  excludedClasses, rootOrder, setRendered, markRendered, isRendered,
  saveConfig,
  setParentMap, setCreationOrder, setEffectiveParentMap,
} from "./state";
import {
  getClassName, getOwned, getOwnedUuids,
  synthesizeLocalOwnership, buildParentMap, buildCreationOrder, buildEffectiveParentMap,
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
  synthesizeLocalOwnership(traceData);
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

  const hasRootOrder = Object.keys(rootOrder).length > 0;
  let serverProc: string | null = null;
  if (hasRootOrder) {
    for (const [proc, uuids] of Object.entries(rootsByProc)) {
      for (const uuid of uuids) {
        if (getClassName(traceData[uuid].ref) in rootOrder) {
          serverProc = proc;
          break;
        }
      }
      if (serverProc) break;
    }
  }

  for (const [proc, rootUuids] of Object.entries(rootsByProc)) {
    const procBox = document.createElement("div");
    procBox.className = "process-box";

    const label = document.createElement("div");
    label.className = "process-label";
    let procLabel = "process " + proc.substring(0, 12) + "...";
    if (hasRootOrder) {
      procLabel = (proc === serverProc ? "server " : "worker ") + proc.substring(0, 12) + "...";
    }
    label.textContent = procLabel;
    procBox.appendChild(label);

    const children = document.createElement("div");
    children.className = "process-children";

    const sorted = defaultSort(rootUuids);

    let hasContent = false;
    for (const uuid of sorted) {
      const el = renderObject(uuid, 0, new Set(), filterText, showIso);
      if (el) {
        children.appendChild(el);
        hasContent = true;
      }
    }

    if (hasContent) {
      procBox.appendChild(children);
      hierarchyEl.appendChild(procBox);

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
