import type { Point, Rect, EdgePath } from "./types";
import { entrypointClasses } from "./state";
import { getClassName } from "./graph";

let edgeLayoutTimer: ReturnType<typeof setTimeout> | null = null;
let hierarchyEl: HTMLElement;

const NODE_GAP = 24;
const ROW_GAP = 48;
const CHANNEL_SPACING = 16;

export function initEdges(): void {
  hierarchyEl = document.getElementById("hierarchy")!;
}

export function scheduleEdgeLayout(): void {
  if (edgeLayoutTimer !== null) clearTimeout(edgeLayoutTimer);
  edgeLayoutTimer = setTimeout(layoutNodes, 100);
}

function findRootBox(el: Element): HTMLElement | null {
  let node = el.closest(".obj-box") as HTMLElement | null;
  while (node) {
    if (node.parentElement && node.parentElement.classList.contains("process-children")) return node;
    node = node.parentElement ? node.parentElement.closest(".obj-box") as HTMLElement | null : null;
  }
  return null;
}

function elRect(el: Element, hRect: DOMRect, scrollLeft: number, scrollTop: number): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: r.left - hRect.left + scrollLeft,
    y: r.top - hRect.top + scrollTop,
    w: r.width,
    h: r.height,
  };
}

interface RootEntry {
  el: HTMLElement;
  id: string;
  partition: number;
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CrossEdge {
  srcRootId: string;
  tgtRootId: string;
  srcBoxEl: Element;
  tgtBoxEl: Element;
  targetUuid: string;
}

type Face = "top" | "bottom" | "left" | "right";

// ── Node placement ──────────────────────────────────────────────

function layoutNodes(): void {
  const allRootBoxes = hierarchyEl.querySelectorAll(
    ":scope > .process-box > .process-children > .obj-box"
  ) as NodeListOf<HTMLElement>;
  if (allRootBoxes.length === 0) { clearEdgeSvg(); return; }

  const entries: RootEntry[] = [];
  let idx = 0;
  for (const rb of allRootBoxes) {
    entries.push({
      el: rb,
      id: "rb_" + idx++,
      partition: parseInt(rb.dataset.row || "0", 10),
      ref: rb.dataset.ref || "",
      x: 0, y: 0,
      w: rb.offsetWidth,
      h: rb.offsetHeight,
    });
  }

  // BFS partition assignment when entrypoints are active
  if (entrypointClasses.size > 0) {
    bfsAssignPartitions(entries, allRootBoxes);
  }

  // Group by partition
  const byPartition = new Map<number, RootEntry[]>();
  for (const e of entries) {
    if (!byPartition.has(e.partition)) byPartition.set(e.partition, []);
    byPartition.get(e.partition)!.push(e);
  }
  const partitions = Array.from(byPartition.keys()).sort((a, b) => a - b);

  // Collect cross-root edges for barycenter sorting
  const crossEdges = collectCrossEdges(entries);

  // Barycenter sort within each row
  barycenterSort(partitions, byPartition, crossEdges, entries);

  // Initial layout pass to trigger child rearrangement
  placeNodes(partitions, byPartition);
  for (const e of entries) {
    e.el.style.left = e.x + "px";
    e.el.style.top = e.y + "px";
    e.el.style.visibility = "visible";
    e.el.dataset.row = String(e.partition);
  }
  rearrangeChildren();

  // Re-measure after rearrangement (children may have changed box sizes)
  for (const e of entries) {
    e.w = e.el.offsetWidth;
    e.h = e.el.offsetHeight;
  }

  // Final layout pass with correct sizes
  placeNodes(partitions, byPartition);
  for (const e of entries) {
    e.el.style.left = e.x + "px";
    e.el.style.top = e.y + "px";
  }

  sizeContainers();
  requestAnimationFrame(() => drawEdges());
}

function placeNodes(partitions: number[], byPartition: Map<number, RootEntry[]>): void {
  let y = 0;
  for (const p of partitions) {
    const row = byPartition.get(p)!;
    let x = 0;
    let maxH = 0;
    for (const e of row) {
      e.x = x;
      e.y = y;
      x += e.w + NODE_GAP;
      if (e.h > maxH) maxH = e.h;
    }
    y += maxH + ROW_GAP;
  }
}

function bfsAssignPartitions(entries: RootEntry[], _allRootBoxes: NodeListOf<HTMLElement>): void {
  const adjacency = new Map<string, Set<string>>();
  const refEls = hierarchyEl.querySelectorAll(".obj-ref[data-ref-target]");
  const entryById = new Map<string, RootEntry>();
  for (const e of entries) entryById.set(e.id, e);

  const rootElToId = new Map<HTMLElement, string>();
  for (const e of entries) rootElToId.set(e.el, e.id);

  for (const refEl of refEls) {
    const targetUuid = (refEl as HTMLElement).dataset.refTarget;
    if (!targetUuid) continue;
    const targetEl = hierarchyEl.querySelector(`.obj-box[data-uuid="${targetUuid}"]`);
    if (!targetEl) continue;
    const srcRoot = findRootBox(refEl);
    const tgtRoot = findRootBox(targetEl);
    if (!srcRoot || !tgtRoot || srcRoot === tgtRoot) continue;
    const srcId = rootElToId.get(srcRoot);
    const tgtId = rootElToId.get(tgtRoot);
    if (!srcId || !tgtId) continue;
    if (!adjacency.has(srcId)) adjacency.set(srcId, new Set());
    adjacency.get(srcId)!.add(tgtId);
  }

  const bfsPartition: Record<string, number> = {};
  const queue: string[] = [];
  for (const e of entries) {
    if (entrypointClasses.has(getClassName(e.ref))) {
      bfsPartition[e.id] = 0;
      queue.push(e.id);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const nb of neighbors) {
      if (!(nb in bfsPartition)) {
        bfsPartition[nb] = bfsPartition[cur] + 1;
        queue.push(nb);
      }
    }
  }
  const maxPartition = Math.max(0, ...Object.values(bfsPartition));
  for (const e of entries) {
    e.partition = bfsPartition[e.id] ?? maxPartition + 1;
  }
}

function collectCrossEdges(entries: RootEntry[]): CrossEdge[] {
  const rootElToId = new Map<HTMLElement, string>();
  for (const e of entries) rootElToId.set(e.el, e.id);

  const edges: CrossEdge[] = [];
  const seen = new Set<string>();
  const refEls = hierarchyEl.querySelectorAll(".obj-ref[data-ref-target]");

  for (const refEl of refEls) {
    const targetUuid = (refEl as HTMLElement).dataset.refTarget;
    if (!targetUuid) continue;
    const targetEl = hierarchyEl.querySelector(`.obj-box[data-uuid="${targetUuid}"]`);
    if (!targetEl) continue;
    const srcRoot = findRootBox(refEl);
    const tgtRoot = findRootBox(targetEl);
    if (!srcRoot || !tgtRoot || srcRoot === tgtRoot) continue;
    const srcId = rootElToId.get(srcRoot);
    const tgtId = rootElToId.get(tgtRoot);
    if (!srcId || !tgtId) continue;

    const srcBox = refEl.closest(".obj-box");
    if (!srcBox) continue;
    const key = srcId + ">" + tgtId + ">" + targetUuid;
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({ srcRootId: srcId, tgtRootId: tgtId, srcBoxEl: srcBox, tgtBoxEl: targetEl, targetUuid });
  }
  return edges;
}

// ── Barycenter crossing minimization ────────────────────────────

function barycenterSort(
  partitions: number[],
  byPartition: Map<number, RootEntry[]>,
  crossEdges: CrossEdge[],
  entries: RootEntry[],
): void {
  if (partitions.length < 2) return;

  const entryById = new Map<string, RootEntry>();
  for (const e of entries) entryById.set(e.id, e);

  // Assign initial x order indices within each row
  for (const p of partitions) {
    const row = byPartition.get(p)!;
    let x = 0;
    for (const e of row) {
      e.x = x;
      x += e.w + NODE_GAP;
    }
  }

  // Build adjacency: for each node, which nodes in adjacent rows is it connected to?
  const neighbors = new Map<string, string[]>();
  for (const edge of crossEdges) {
    if (!neighbors.has(edge.srcRootId)) neighbors.set(edge.srcRootId, []);
    if (!neighbors.has(edge.tgtRootId)) neighbors.set(edge.tgtRootId, []);
    neighbors.get(edge.srcRootId)!.push(edge.tgtRootId);
    neighbors.get(edge.tgtRootId)!.push(edge.srcRootId);
  }

  // Top-down sweep: sort each row by barycenter of connected nodes in previous row
  for (let i = 1; i < partitions.length; i++) {
    const row = byPartition.get(partitions[i])!;
    const prevRow = byPartition.get(partitions[i - 1])!;
    const prevXCenter = new Map<string, number>();
    for (const e of prevRow) {
      prevXCenter.set(e.id, e.x + e.w / 2);
    }

    row.sort((a, b) => {
      const aNeighbors = (neighbors.get(a.id) || []).filter(n => prevXCenter.has(n));
      const bNeighbors = (neighbors.get(b.id) || []).filter(n => prevXCenter.has(n));
      const aBarycenter = aNeighbors.length > 0
        ? aNeighbors.reduce((s, n) => s + prevXCenter.get(n)!, 0) / aNeighbors.length
        : Infinity;
      const bBarycenter = bNeighbors.length > 0
        ? bNeighbors.reduce((s, n) => s + prevXCenter.get(n)!, 0) / bNeighbors.length
        : Infinity;
      return aBarycenter - bBarycenter;
    });

    // Recompute x positions after sort
    let x = 0;
    for (const e of row) {
      e.x = x;
      x += e.w + NODE_GAP;
    }
  }
}

// ── Child rearrangement ─────────────────────────────────────────

type AnchorFace = "top" | "bottom";

interface IncomingRef {
  srcPart: number;
}

interface RootMaps {
  yByUuid: Record<string, number>;
  partByUuid: Record<string, number>;
  incomingByUuid: Record<string, IncomingRef[]>;
}

function rearrangeChildren(): void {
  const rootBoxes = hierarchyEl.querySelectorAll(
    ":scope > .process-box > .process-children > .obj-box"
  ) as NodeListOf<HTMLElement>;

  const maps: RootMaps = { yByUuid: {}, partByUuid: {}, incomingByUuid: {} };
  for (const rb of rootBoxes) {
    const y = rb.offsetTop;
    const part = parseInt(rb.dataset.row || "0", 10);
    const uuid = rb.dataset.uuid;
    if (uuid) {
      maps.yByUuid[uuid] = y;
      maps.partByUuid[uuid] = part;
    }
    for (const inner of rb.querySelectorAll(".obj-box[data-uuid]") as NodeListOf<HTMLElement>) {
      if (inner.dataset.uuid) {
        maps.yByUuid[inner.dataset.uuid] = y;
        maps.partByUuid[inner.dataset.uuid] = part;
      }
    }
  }

  const rootElToInfo = new Map<HTMLElement, { part: number }>();
  for (const rb of rootBoxes) {
    rootElToInfo.set(rb, { part: parseInt(rb.dataset.row || "0", 10) });
  }
  for (const refEl of hierarchyEl.querySelectorAll(".obj-ref[data-ref-target]") as NodeListOf<HTMLElement>) {
    const tid = refEl.dataset.refTarget;
    if (!tid) continue;
    const srcRoot = findRootBox(refEl);
    const tgtEl = hierarchyEl.querySelector(`.obj-box[data-uuid="${tid}"]`);
    if (!tgtEl) continue;
    const tgtRoot = findRootBox(tgtEl);
    if (!srcRoot || !tgtRoot || srcRoot === tgtRoot) continue;
    const srcInfo = rootElToInfo.get(srcRoot);
    const tgtInfo = rootElToInfo.get(tgtRoot);
    if (!srcInfo || !tgtInfo) continue;
    if (!maps.incomingByUuid[tid]) maps.incomingByUuid[tid] = [];
    maps.incomingByUuid[tid].push({ srcPart: srcInfo.part });
  }

  for (const rb of rootBoxes) {
    const srcPart = parseInt(rb.dataset.row || "0", 10);
    sortLevel(rb, rb.offsetTop, srcPart, maps, true);
  }
}

interface ClassifiedChild {
  el: HTMLElement;
  face: AnchorFace | null;
  hasChildren: boolean;
}

function sortLevel(
  parent: HTMLElement, rootY: number, srcPart: number, maps: RootMaps, isRootLevel: boolean
): AnchorFace | null {
  const childrenDiv = parent.querySelector(":scope > .obj-children");
  if (!childrenDiv) return null;

  const children = Array.from(childrenDiv.children) as HTMLElement[];
  const classified: ClassifiedChild[] = [];

  for (const child of children) {
    if (child.classList.contains("obj-ref")) {
      const face = classifyRefFace(child, rootY, srcPart, maps);
      classified.push({ el: child, face, hasChildren: false });
    } else if (child.classList.contains("obj-box")) {
      const childFace = sortLevel(child, rootY, srcPart, maps, false);
      let face = childFace;
      const boxUuid = child.dataset.uuid;
      const incoming = boxUuid ? maps.incomingByUuid[boxUuid] : undefined;
      if (incoming && incoming.length > 0) {
        const aboveCount = incoming.filter(r => r.srcPart < srcPart).length;
        const belowCount = incoming.filter(r => r.srcPart > srcPart).length;
        let incomingFace: AnchorFace | null = null;
        if (aboveCount > 0 && belowCount === 0) incomingFace = "top";
        else if (belowCount > 0 && aboveCount === 0) incomingFace = "bottom";
        else if (aboveCount > 0 && belowCount > 0) incomingFace = aboveCount >= belowCount ? "top" : "bottom";

        if (face === null) face = incomingFace;
        else if (incomingFace !== null && incomingFace !== face) {
          face = aboveCount >= belowCount ? "top" : "bottom";
        }
      }
      const hasChildren = !!child.querySelector(":scope > .obj-children");
      classified.push({ el: child, face, hasChildren });
    } else {
      classified.push({ el: child, face: null, hasChildren: false });
    }
  }

  // Store face on elements
  for (const c of classified) {
    if (c.face) c.el.dataset.face = c.face;
    else delete c.el.dataset.face;
    delete c.el.dataset.hdir;
  }

  // DOM placement
  childrenDiv.innerHTML = "";

  const topAnchored = classified.filter(c => c.face === "top");
  const bottomAnchored = classified.filter(c => c.face === "bottom");
  const unanchored = classified.filter(c => c.face === null);

  const makeRow = (items: ClassifiedChild[], cls: string) => {
    if (items.length === 0) return;
    const row = document.createElement("div");
    row.className = "child-row " + cls;
    for (const { el } of items) row.appendChild(el);
    childrenDiv.appendChild(row);
  };

  makeRow(topAnchored, "anchored-top");

  if (isRootLevel && unanchored.length > 0) {
    const leaves = unanchored.filter(c => !c.hasChildren);
    const branches = unanchored.filter(c => c.hasChildren);
    if (leaves.length > 0 && branches.length > 0) {
      const mid = document.createElement("div");
      mid.className = "mid-layout";
      const leafCol = document.createElement("div");
      leafCol.className = "leaf-col";
      for (const { el } of leaves) leafCol.appendChild(el);
      const branchCol = document.createElement("div");
      branchCol.className = "branch-col";
      for (const { el } of branches) branchCol.appendChild(el);
      mid.appendChild(leafCol);
      mid.appendChild(branchCol);
      childrenDiv.appendChild(mid);
    } else {
      makeRow(unanchored, "internal");
    }
  } else if (unanchored.length > 0) {
    for (const { el } of unanchored) childrenDiv.appendChild(el);
  }

  makeRow(bottomAnchored, "anchored-bottom");

  // Propagate: majority vote
  let topCount = 0;
  let bottomCount = 0;
  for (const c of classified) {
    if (c.face === "top") topCount++;
    else if (c.face === "bottom") bottomCount++;
  }
  if (topCount === 0 && bottomCount === 0) return null;
  return topCount >= bottomCount ? "top" : "bottom";
}

function classifyRefFace(
  ref: HTMLElement, rootY: number, srcPart: number, maps: RootMaps
): AnchorFace | null {
  const tid = ref.dataset.refTarget;
  if (!tid) return null;
  const ty = maps.yByUuid[tid];
  if (ty === undefined || ty === rootY) return null;
  const tgtPart = maps.partByUuid[tid] ?? srcPart;
  if (tgtPart === srcPart) return null;
  return tgtPart < srcPart ? "top" : "bottom";
}

// ── Container sizing ────────────────────────────────────────────

function sizeContainers(): void {
  const containers = hierarchyEl.querySelectorAll(".process-children") as NodeListOf<HTMLElement>;
  for (const container of containers) {
    let maxRight = 0;
    let maxBottom = 0;
    for (const child of container.querySelectorAll(":scope > .obj-box") as NodeListOf<HTMLElement>) {
      const r = child.offsetLeft + child.offsetWidth;
      const b = child.offsetTop + child.offsetHeight;
      if (r > maxRight) maxRight = r;
      if (b > maxBottom) maxBottom = b;
    }
    container.style.width = (maxRight + 16) + "px";
    container.style.height = (maxBottom + 16) + "px";
  }
}

// ── Edge drawing ────────────────────────────────────────────────

interface RoutedEdge {
  srcEl: Element;
  tgtEl: Element;
  srcRoot: HTMLElement;
  tgtRoot: HTMLElement;
  targetUuid: string;
  srcPartition: number;
  tgtPartition: number;
  srcRootId: string;
  tgtRootId: string;
}

function drawEdges(): void {
  const refEls = hierarchyEl.querySelectorAll(".obj-ref[data-ref-target]");
  if (refEls.length === 0) { clearEdgeSvg(); return; }

  const hRect = hierarchyEl.getBoundingClientRect();
  const scrollLeft = hierarchyEl.scrollLeft || 0;
  const scrollTop = hierarchyEl.scrollTop || 0;

  // Build root box lookup
  const allRootBoxes = hierarchyEl.querySelectorAll(
    ":scope > .process-box > .process-children > .obj-box"
  ) as NodeListOf<HTMLElement>;
  const rootElToPartition = new Map<HTMLElement, number>();
  const rootElToId = new Map<HTMLElement, string>();
  let rbIdx = 0;
  for (const rb of allRootBoxes) {
    rootElToPartition.set(rb, parseInt(rb.dataset.row || "0", 10));
    rootElToId.set(rb, "rb_" + rbIdx++);
  }

  // Collect edges
  const edges: RoutedEdge[] = [];
  const seen = new Set<string>();

  for (const refEl of refEls) {
    const targetUuid = (refEl as HTMLElement).dataset.refTarget;
    if (!targetUuid) continue;
    const targetEl = hierarchyEl.querySelector(`.obj-box[data-uuid="${targetUuid}"]`);
    if (!targetEl) continue;
    const srcRoot = findRootBox(refEl);
    const tgtRoot = findRootBox(targetEl);
    if (!srcRoot || !tgtRoot || srcRoot === tgtRoot) continue;

    const srcId = rootElToId.get(srcRoot) || "";
    const tgtId = rootElToId.get(tgtRoot) || "";
    const key = (refEl as HTMLElement).dataset.uuid + ">" + targetUuid;
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      srcEl: refEl,
      tgtEl: targetEl,
      srcRoot,
      tgtRoot,
      targetUuid,
      srcPartition: rootElToPartition.get(srcRoot) || 0,
      tgtPartition: rootElToPartition.get(tgtRoot) || 0,
      srcRootId: srcId,
      tgtRootId: tgtId,
    });
  }

  if (edges.length === 0) { clearEdgeSvg(); return; }

  // Classify edges and assign faces
  const faceEdges = new Map<Element, { top: RoutedEdge[]; bottom: RoutedEdge[]; left: RoutedEdge[]; right: RoutedEdge[] }>();

  function getFace(el: Element) {
    if (!faceEdges.has(el)) faceEdges.set(el, { top: [], bottom: [], left: [], right: [] });
    return faceEdges.get(el)!;
  }

  function resolveEdgeFace(el: Element, isSource: boolean, edge: RoutedEdge): Face {
    const dataFace = (el as HTMLElement).dataset.face;
    if (dataFace === "top" || dataFace === "bottom") return dataFace;
    const srcAbove = edge.srcPartition < edge.tgtPartition;
    if (isSource) return srcAbove ? "bottom" : "top";
    return srcAbove ? "top" : "bottom";
  }

  for (const edge of edges) {
    const srcFace = resolveEdgeFace(edge.srcEl, true, edge);
    const tgtFace = resolveEdgeFace(edge.tgtEl, false, edge);
    getFace(edge.srcEl)[srcFace].push(edge);
    getFace(edge.tgtEl)[tgtFace].push(edge);
  }

  // Compute slot positions for each face of each element
  // Outbound: centered on the element. Inbound: centered, then shifted
  // right with 1.5x arrow margin (12px) until no two overlap.
  type SlotMap = Map<Element, Map<Face, Map<RoutedEdge, number>>>;
  const slotPositions: SlotMap = new Map();
  const ARROW_MARGIN = 12;

  for (const [el, faces] of faceEdges) {
    const rect = elRect(el, hRect, scrollLeft, scrollTop);
    const elSlots = new Map<Face, Map<RoutedEdge, number>>();

    for (const face of ["top", "bottom", "left", "right"] as Face[]) {
      const edgeList = faces[face];
      if (edgeList.length === 0) continue;

      const length = (face === "top" || face === "bottom") ? rect.w : rect.h;
      const map = new Map<RoutedEdge, number>();
      const center = length / 2;

      const outbound: RoutedEdge[] = [];
      const inbound: RoutedEdge[] = [];
      for (const edge of edgeList) {
        if (edge.srcEl === el) outbound.push(edge);
        else inbound.push(edge);
      }

      const usedOffsets: number[] = [];
      for (const edge of outbound) {
        map.set(edge, center);
        usedOffsets.push(center);
      }

      // Sort inbound by opposite endpoint's absolute X
      if (face === "top" || face === "bottom") {
        inbound.sort((a, b) => {
          const rA = elRect(a.srcEl, hRect, scrollLeft, scrollTop);
          const rB = elRect(b.srcEl, hRect, scrollLeft, scrollTop);
          return (rA.x + rA.w / 2) - (rB.x + rB.w / 2);
        });
      }

      for (const edge of inbound) {
        let offset = center;
        while (usedOffsets.some(u => Math.abs(u - offset) < ARROW_MARGIN)) {
          offset += ARROW_MARGIN;
        }
        offset = Math.max(6, Math.min(length - 6, offset));
        map.set(edge, offset);
        usedOffsets.push(offset);
      }

      elSlots.set(face, map);
    }
    slotPositions.set(el, elSlots);
  }

  // Helper to get anchor point for an edge at a given element's face
  function getAnchor(el: Element, face: Face, edge: RoutedEdge): Point {
    const rect = elRect(el, hRect, scrollLeft, scrollTop);
    const elSlots = slotPositions.get(el);
    const faceSlots = elSlots?.get(face);
    const offset = faceSlots?.get(edge) ?? (
      (face === "top" || face === "bottom") ? rect.w / 2 : rect.h / 2
    );

    switch (face) {
      case "top": return { x: rect.x + offset, y: rect.y };
      case "bottom": return { x: rect.x + offset, y: rect.y + rect.h };
      case "left": return { x: rect.x, y: rect.y + offset };
      case "right": return { x: rect.x + rect.w, y: rect.y + offset };
    }
  }

  // Route paths
  const paths: EdgePath[] = [];

  // Collect root box rects for obstacle avoidance
  const rootRects = new Map<HTMLElement, Rect>();
  for (const rb of allRootBoxes) {
    rootRects.set(rb, elRect(rb, hRect, scrollLeft, scrollTop));
  }

  // Build row extents for gap-centered horizontal channels
  const rowExtents = new Map<number, { top: number; bottom: number }>();
  for (const rect of rootRects.values()) {
    const part = rootElToPartition.get(
      Array.from(rootRects.entries()).find(([, r]) => r === rect)?.[0]!
    ) ?? 0;
    const ext = rowExtents.get(part);
    if (!ext) rowExtents.set(part, { top: rect.y, bottom: rect.y + rect.h });
    else {
      ext.top = Math.min(ext.top, rect.y);
      ext.bottom = Math.max(ext.bottom, rect.y + rect.h);
    }
  }

  function gapCenterY(partA: number, partB: number): number {
    const upper = Math.min(partA, partB);
    const lower = Math.max(partA, partB);
    const upperExt = rowExtents.get(upper);
    const lowerExt = rowExtents.get(lower);
    if (upperExt && lowerExt) return Math.round((upperExt.bottom + lowerExt.top) / 2);
    return 0;
  }

  // Channel allocator: parallel segments maintain margin only when Y/X ranges overlap
  const usedChannelY: { y: number; xMin: number; xMax: number }[] = [];
  const usedChannelX: { x: number; yMin: number; yMax: number }[] = [];
  const ROOT_MARGIN = 20;

  function allocateChannelY(preferredY: number, xMin: number, xMax: number): number {
    let y = Math.round(preferredY);
    const lo = Math.min(xMin, xMax);
    const hi = Math.max(xMin, xMax);
    while (usedChannelY.some(c => c.y === y && c.xMax > lo && c.xMin < hi)) y += CHANNEL_SPACING;
    usedChannelY.push({ y, xMin: lo, xMax: hi });
    return y;
  }

  function allocateChannelX(preferredX: number, yMin: number, yMax: number): number {
    let x = Math.round(preferredX);
    const lo = Math.min(yMin, yMax);
    const hi = Math.max(yMin, yMax);
    while (usedChannelX.some(c => c.x === x && c.yMax > lo && c.yMin < hi)) x += CHANNEL_SPACING;
    usedChannelX.push({ x, yMin: lo, yMax: hi });
    return x;
  }

  // Sort edges by source element absolute X so channels don't cross between source verticals
  const edgeOrder = edges.map((edge, i) => {
    const srcRect = elRect(edge.srcEl, hRect, scrollLeft, scrollTop);
    const tgtRect = elRect(edge.tgtEl, hRect, scrollLeft, scrollTop);
    return { idx: i, srcX: srcRect.x + srcRect.w / 2, tgtX: tgtRect.x + tgtRect.w / 2 };
  });
  edgeOrder.sort((a, b) => a.srcX - b.srcX);

  for (const { idx: i } of edgeOrder) {
    const edge = edges[i];
    const rowDelta = Math.abs(edge.srcPartition - edge.tgtPartition);

    const srcFace = resolveEdgeFace(edge.srcEl, true, edge);
    const tgtFace = resolveEdgeFace(edge.tgtEl, false, edge);

    const start = getAnchor(edge.srcEl, srcFace, edge);
    const end = getAnchor(edge.tgtEl, tgtFace, edge);

    const srcRootRect = rootRects.get(edge.srcRoot)!;
    const tgtRootRect = rootRects.get(edge.tgtRoot)!;

    const srcRootFaceY = srcFace === "top" ? srcRootRect.y : srcRootRect.y + srcRootRect.h;
    const tgtRootFaceY = tgtFace === "top" ? tgtRootRect.y : tgtRootRect.y + tgtRootRect.h;

    if (Math.abs(start.x - end.x) < 1 && Math.abs(srcRootFaceY - tgtRootFaceY) < 1) {
      paths.push({ pts: [start, end], targetUuid: edge.targetUuid, id: "edge_" + i });
      continue;
    }

    if (rowDelta <= 1) {
      // Single-row hop: at most 2 bends
      const midY = allocateChannelY(gapCenterY(edge.srcPartition, edge.tgtPartition), start.x, end.x);
      paths.push({
        pts: [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
        targetUuid: edge.targetUuid,
        id: "edge_" + i,
      });
    } else {
      // Multi-row: at most 4 bends (child → root face → horizontal → root face → child)
      const midY = allocateChannelY(gapCenterY(edge.srcPartition, edge.tgtPartition), start.x, end.x);

      // Check if horizontal segment crosses any uninvolved roots
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      let needsDetour = false;
      for (const [rb, rect] of rootRects) {
        if (rb === edge.srcRoot || rb === edge.tgtRoot) continue;
        if (rect.x + rect.w > minX && rect.x < maxX &&
            rect.y < midY && rect.y + rect.h > midY) {
          needsDetour = true;
          break;
        }
      }

      if (!needsDetour) {
        paths.push({
          pts: [
            start,
            { x: start.x, y: srcRootFaceY },
            { x: start.x, y: midY },
            { x: end.x, y: midY },
            { x: end.x, y: tgtRootFaceY },
            end,
          ],
          targetUuid: edge.targetUuid,
          id: "edge_" + i,
        });
      } else {
        // Route around: vertical channel outside all roots with margin
        const allLeft = Math.min(...Array.from(rootRects.values()).map(r => r.x));
        const allRight = Math.max(...Array.from(rootRects.values()).map(r => r.x + r.w));
        const distLeft = start.x - allLeft + end.x - allLeft;
        const distRight = allRight - start.x + allRight - end.x;
        const channelX = allocateChannelX(
          distLeft < distRight ? allLeft - ROOT_MARGIN : allRight + ROOT_MARGIN,
          srcRootFaceY, tgtRootFaceY
        );

        paths.push({
          pts: [
            start,
            { x: start.x, y: srcRootFaceY },
            { x: channelX, y: srcRootFaceY },
            { x: channelX, y: tgtRootFaceY },
            { x: end.x, y: tgtRootFaceY },
            end,
          ],
          targetUuid: edge.targetUuid,
          id: "edge_" + i,
        });
      }
    }
  }

  drawPaths(paths);
}

// ── SVG rendering ───────────────────────────────────────────────

function drawPaths(paths: EdgePath[]): void {
  clearEdgeSvg();
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.id = "edge-svg";
  svg.setAttribute("width", String(hierarchyEl.scrollWidth));
  svg.setAttribute("height", String(hierarchyEl.scrollHeight));

  const defs = document.createElementNS(svgNs, "defs");
  const marker = document.createElementNS(svgNs, "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS(svgNs, "path");
  arrow.setAttribute("d", "M0,0 L8,3 L0,6 Z");
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const p of paths) {
    const d = "M" + p.pts.map(pt => pt.x + "," + pt.y).join(" L");
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", d);
    path.setAttribute("marker-end", "url(#arrowhead)");
    path.setAttribute("data-edge-id", p.id);
    path.setAttribute("data-target-uuid", p.targetUuid);
    svg.appendChild(path);
  }

  hierarchyEl.appendChild(svg);
}

export function clearEdgeSvg(): void {
  const old = document.getElementById("edge-svg");
  if (old) old.remove();
}

export function highlightEdges(targetUuid: string): void {
  const svg = document.getElementById("edge-svg");
  if (!svg) return;
  for (const path of svg.querySelectorAll("path[data-target-uuid]")) {
    if (path.getAttribute("data-target-uuid") === targetUuid) {
      path.classList.add("edge-highlight");
    }
  }
}

export function clearEdgeHighlights(): void {
  const svg = document.getElementById("edge-svg");
  if (!svg) return;
  for (const path of svg.querySelectorAll(".edge-highlight")) {
    path.classList.remove("edge-highlight");
  }
}
