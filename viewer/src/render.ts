import type { FuncCallNode } from "./types";
import {
  traceData, parentMap, effectiveParentMap, creationOrder, collapsedSet,
  excludedClasses, rootOrder, objectMethods, functionData, rootFuncId,
  setRendered, markRendered, isRendered,
  saveConfig,
  setParentMap, setCreationOrder, setEffectiveParentMap,
} from "./state";
import {
  getClassName, getOwned, getOwnedIds,
  synthesizeLocalOwnership, buildParentMap, buildCreationOrder, buildEffectiveParentMap,
  findRoots, canReach, isPinnedRoot, participatesInOwnership, clearReachCache,
} from "./graph";
import { scheduleEdgeLayout, highlightEdges, clearEdgeHighlights } from "./edges";
import { MODULE_KEY } from "./functions";

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
  for (const id of allRoots) {
    const proc = traceData[id].process || "unknown";
    if (!rootsByProc[proc]) rootsByProc[proc] = [];
    rootsByProc[proc].push(id);
  }

  const hasRootOrder = Object.keys(rootOrder).length > 0;
  let serverProc: string | null = null;
  if (hasRootOrder) {
    for (const [proc, ids] of Object.entries(rootsByProc)) {
      for (const id of ids) {
        if (getClassName(traceData[id].ref) in rootOrder) {
          serverProc = proc;
          break;
        }
      }
      if (serverProc) break;
    }
  }

  const moduleMethods = objectMethods[MODULE_KEY];
  const moduleProc = rootFuncId && functionData?.[rootFuncId]
    ? functionData[rootFuncId].process : null;

  for (const [proc, rootIds] of Object.entries(rootsByProc)) {
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

    if (moduleMethods && moduleMethods.length > 0 && proc === moduleProc) {
      const modBox = renderModuleBox(moduleMethods);
      if (modBox) {
        children.appendChild(modBox);
      }
    }

    const sorted = defaultSort(rootIds);

    let hasContent = false;
    for (const id of sorted) {
      const el = renderObject(id, 0, new Set(), filterText, showIso);
      if (el) {
        children.appendChild(el);
        hasContent = true;
      }
    }

    if (hasContent || children.childElementCount > 0) {
      procBox.appendChild(children);
      hierarchyEl.appendChild(procBox);
    }
  }

  const totalShown = hierarchyEl.querySelectorAll(".obj-box:not(.hidden)").length;
  statsEl.textContent = totalShown + " / " + totalObjects + " objects shown";

  requestAnimationFrame(() => {
    scheduleEdgeLayout();
    requestAnimationFrame(() => drawAllFuncEdges());
  });
}

function matchesFilter(id: string, filterText: string): boolean {
  if (!filterText) return true;
  if (!traceData) return false;
  const obj = traceData[id];
  if (!obj) return false;
  return getClassName(obj.ref).toLowerCase().includes(filterText);
}

function subtreeMatchesFilter(id: string, filterText: string, visited: Set<string>): boolean {
  if (!traceData) return false;
  if (visited.has(id)) return false;
  visited.add(id);
  if (matchesFilter(id, filterText)) return true;
  const obj = traceData[id];
  if (!obj) return false;
  for (const child of getOwnedIds(obj)) {
    if (traceData[child] && subtreeMatchesFilter(child, filterText, visited)) return true;
  }
  return false;
}

function isExcluded(id: string): boolean {
  if (!traceData) return false;
  const obj = traceData[id];
  if (!obj) return false;
  return excludedClasses.has(getClassName(obj.ref));
}

function defaultSort(ids: string[]): string[] {
  return ids.slice().sort((a, b) => {
    const oa = getOwnedIds(traceData![a]).length;
    const ob = getOwnedIds(traceData![b]).length;
    return ob - oa;
  });
}

function highlightGroup(id: string): void {
  for (const el of hierarchyEl.querySelectorAll(`.obj-ref[data-ref-target="${id}"]`)) {
    el.classList.add("group-highlight");
  }
  const box = hierarchyEl.querySelector(`.obj-box[data-node-id="${id}"]`);
  if (box) box.classList.add("group-highlight");
  highlightEdges(id);
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
  const parentId = parentBox.dataset.nodeId;
  if (!parentId) return;
  highlightGroup(parentId);
}

function toggleCollapse(id: string, box: HTMLElement): void {
  if (collapsedSet.has(id)) {
    collapsedSet.delete(id);
    box.classList.remove("collapsed");
  } else {
    collapsedSet.add(id);
    box.classList.add("collapsed");
  }
  saveConfig();
  scheduleEdgeLayout();
}

function renderObject(
  id: string,
  depth: number,
  visited: Set<string>,
  filterText: string,
  showIso: boolean,
  attrName?: string,
  skipOwned?: string,
): HTMLElement | null {
  if (!traceData) return null;
  const obj = traceData[id];
  if (!obj) return null;

  if (isExcluded(id)) return null;
  if (!showIso && !participatesInOwnership(id, traceData, parentMap)) return null;

  if (visited.has(id)) {
    if (!subtreeMatchesFilter(id, filterText, new Set())) return null;
    return renderRef(id, attrName);
  }

  if (isRendered(id)) {
    if (!subtreeMatchesFilter(id, filterText, new Set())) return null;
    return renderRef(id, attrName);
  }

  if (!subtreeMatchesFilter(id, filterText, new Set(visited))) return null;

  visited.add(id);
  markRendered(id);

  const box = document.createElement("div");
  box.className = "obj-box depth-" + (depth % 7);
  box.dataset.nodeId = id;
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

  if (collapsedSet.has(id)) box.classList.add("collapsed");

  label.addEventListener("click", e => {
    e.stopPropagation();
    toggleCollapse(id, box);
  });

  box.addEventListener("mouseenter", e => {
    e.stopPropagation();
    clearGroupHighlight();
    highlightGroup(id);
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
      const oa = traceData![a[0]] ? getOwnedIds(traceData![a[0]]).length : 0;
      const ob = traceData![b[0]] ? getOwnedIds(traceData![b[0]]).length : 0;
      return ob - oa;
    });

    let hasVisibleChild = false;
    for (const [child, childAttr] of sortedOwns) {
      let el: HTMLElement | null;
      const childEffParents = effectiveParentMap[child];
      if (isPinnedRoot(child) || (childEffParents && childEffParents.length > 0 && !childEffParents.includes(id))) {
        if (!subtreeMatchesFilter(child, filterText, new Set())) continue;
        el = renderRef(child, childAttr);
      } else if (traceData[child] && canReach(traceData, child, id, new Set())) {
        const childOwns = traceData[child].owns;
        const ownsMap = Array.isArray(childOwns) ? {} as Record<string, string> : (childOwns || {});
        if (id in ownsMap) {
          el = renderObject(child, depth + 1, new Set(visited), filterText, showIso, childAttr, id);
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

  const methods = objectMethods[id];
  if (methods && methods.length > 0) {
    const flat = flattenFuncTree(methods, id);
    if (flat.length > 0) {
      const section = document.createElement("div");
      section.className = "func-section";
      for (const entry of flat) {
        section.appendChild(renderFlatFuncBox(entry));
      }
      box.appendChild(section);
    }
  }

  return box;
}

function renderModuleBox(methods: FuncCallNode[]): HTMLElement | null {
  const flat = flattenFuncTree(methods, null);
  if (flat.length === 0) return null;

  const rootRef = rootFuncId && functionData?.[rootFuncId]
    ? functionData[rootFuncId].ref : "";
  const parts = rootRef.split("/");
  const fileName = parts.length > 0 ? parts[parts.length - 1].split(":")[0] : "module";

  const box = document.createElement("div");
  box.className = "obj-box module-box depth-0";
  box.dataset.row = "0";

  const label = document.createElement("div");
  label.className = "obj-label";
  label.textContent = fileName;
  box.appendChild(label);

  const section = document.createElement("div");
  section.className = "func-section";
  for (const entry of flat) {
    section.appendChild(renderFlatFuncBox(entry));
  }
  box.appendChild(section);

  return box;
}

interface FlatFuncEntry {
  node: FuncCallNode;
  id: string;
  parentId: string | null;
  depth: number;
  contextObj: string | null;
}

const FUNC_INDENT = 16;

function flattenFuncTree(roots: FuncCallNode[], contextObj: string | null): FlatFuncEntry[] {
  const flat: FlatFuncEntry[] = [];
  let seq = 0;

  function walk(node: FuncCallNode, parentId: string | null, depth: number): void {
    const id = `f${seq++}`;
    flat.push({ node, id, parentId, depth, contextObj });
    for (const child of node.children) {
      walk(child, id, depth + 1);
    }
  }

  for (const root of roots) {
    walk(root, null, 0);
  }
  return flat;
}

function renderFlatFuncBox(entry: FlatFuncEntry): HTMLElement {
  const { node, id, parentId, depth, contextObj } = entry;
  const isCrossObject = node.boundTo !== null && node.boundTo !== contextObj;

  const box = document.createElement("div");
  box.dataset.funcId = id;
  box.dataset.funcDepth = String(depth);
  if (parentId !== null) box.dataset.funcParent = parentId;
  box.style.marginLeft = (depth * FUNC_INDENT) + "px";

  if (isCrossObject) {
    box.className = "func-box cross-obj";
    const targetClass = traceData?.[node.boundTo!]
      ? getClassName(traceData[node.boundTo!].ref) : "?";
    const prefix = node.count > 1 ? `(${node.count}) ` : "";
    box.textContent = `${prefix}→ ${targetClass}.${node.name}`;
    box.style.cursor = "pointer";
    box.addEventListener("click", () => {
      const target = hierarchyEl.querySelector(`.obj-box[data-node-id="${node.boundTo}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("group-highlight");
        setTimeout(() => target.classList.remove("group-highlight"), 2000);
      }
    });
  } else {
    box.className = "func-box" + (node.boundTo === null ? " unbound" : "");
    const prefix = node.count > 1 ? `(${node.count}) ` : "";
    box.textContent = prefix + node.name;
  }

  return box;
}

export function drawAllFuncEdges(): void {
  for (const svg of document.querySelectorAll(".func-edges")) {
    svg.remove();
  }

  for (const section of document.querySelectorAll(".func-section")) {
    drawFuncSectionEdges(section as HTMLElement);
  }
}

function drawFuncSectionEdges(section: HTMLElement): void {
  const boxes = section.querySelectorAll<HTMLElement>("[data-func-id]");
  if (boxes.length < 2) return;

  const boxMap = new Map<string, HTMLElement>();
  const edges: { parentId: string; childId: string }[] = [];

  for (const box of boxes) {
    boxMap.set(box.dataset.funcId!, box);
    if (box.dataset.funcParent) {
      edges.push({ parentId: box.dataset.funcParent, childId: box.dataset.funcId! });
    }
  }

  if (edges.length === 0) return;

  const sRect = section.getBoundingClientRect();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("func-edges");
  svg.setAttribute("width", String(section.scrollWidth));
  svg.setAttribute("height", String(section.scrollHeight));

  for (const edge of edges) {
    const parentEl = boxMap.get(edge.parentId);
    const childEl = boxMap.get(edge.childId);
    if (!parentEl || !childEl) continue;

    const pr = parentEl.getBoundingClientRect();
    const cr = childEl.getBoundingClientRect();

    const childDepth = parseInt(childEl.dataset.funcDepth || "0", 10);
    const gutterX = (childDepth * FUNC_INDENT) + FUNC_INDENT / 2;

    const py = pr.bottom - sRect.top;
    const cy = cr.top - sRect.top + cr.height / 2;
    const cx = cr.left - sRect.left;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${gutterX} ${py} L ${gutterX} ${cy} L ${cx} ${cy}`);
    path.setAttribute("fill", "none");

    const isUnbound = childEl.classList.contains("unbound");
    const isCross = childEl.classList.contains("cross-obj");
    path.setAttribute("stroke", isCross ? "#c95" : isUnbound ? "#555" : "#5a9");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-opacity", "0.6");

    svg.appendChild(path);
  }

  section.appendChild(svg);
}

function renderRef(id: string, attrName?: string): HTMLElement | null {
  if (!traceData) return null;
  const obj = traceData[id];
  if (!obj) return null;
  if (isExcluded(id)) return null;

  const el = document.createElement("div");
  el.className = "obj-ref";
  el.textContent = (attrName || getClassName(obj.ref)) + " ⇗";
  el.dataset.nodeId = id;
  el.dataset.refTarget = id;

  el.addEventListener("mouseenter", e => {
    e.stopPropagation();
    clearGroupHighlight();
    highlightGroup(id);
  });
  el.addEventListener("mouseleave", e => {
    e.stopPropagation();
    clearGroupHighlight();
    rehighlightParent(el, e);
  });

  el.addEventListener("click", () => {
    const target = hierarchyEl.querySelector(`.obj-box[data-node-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      (target as HTMLElement).style.outline = "2px solid #5a9";
      setTimeout(() => (target as HTMLElement).style.outline = "", 1500);
    }
  });

  return el;
}
