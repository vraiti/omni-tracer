import type { Point, Rect, EdgePath } from "./types";
import { entrypointClasses } from "./state";
import { getClassName } from "./graph";

let edgeLayoutTimer: ReturnType<typeof setTimeout> | null = null;
let hierarchyEl: HTMLElement;

const NODE_GAP = 24;
const ROW_GAP = 48;
const CHANNEL_SPACING = 10;

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

type RefDir = "up" | "down" | "none" | "mixed";

interface IncomingRef {
  srcPart: number;
  srcXCenter: number;
}

interface RootMaps {
  yByUuid: Record<string, number>;
  xByUuid: Record<string, number>;
  partByUuid: Record<string, number>;
  incomingByUuid: Record<string, IncomingRef[]>;
}

function rearrangeChildren(): void {
  const rootBoxes = hierarchyEl.querySelectorAll(
    ":scope > .process-box > .process-children > .obj-box"
  ) as NodeListOf<HTMLElement>;

  const maps: RootMaps = { yByUuid: {}, xByUuid: {}, partByUuid: {}, incomingByUuid: {} };
  for (const rb of rootBoxes) {
    const y = rb.offsetTop;
    const xCenter = rb.offsetLeft + rb.offsetWidth / 2;
    const part = parseInt(rb.dataset.row || "0", 10);
    const uuid = rb.dataset.uuid;
    if (uuid) {
      maps.yByUuid[uuid] = y;
      maps.xByUuid[uuid] = xCenter;
      maps.partByUuid[uuid] = part;
    }
    for (const inner of rb.querySelectorAll(".obj-box[data-uuid]") as NodeListOf<HTMLElement>) {
      if (inner.dataset.uuid) {
        maps.yByUuid[inner.dataset.uuid] = y;
        maps.xByUuid[inner.dataset.uuid] = xCenter;
        maps.partByUuid[inner.dataset.uuid] = part;
      }
    }
  }

  const rootElToInfo = new Map<HTMLElement, { part: number; xCenter: number }>();
  for (const rb of rootBoxes) {
    rootElToInfo.set(rb, {
      part: parseInt(rb.dataset.row || "0", 10),
      xCenter: rb.offsetLeft + rb.offsetWidth / 2,
    });
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
    if (!srcInfo || !tgtInfo || Math.abs(srcInfo.part - tgtInfo.part) <= 1) continue;
    if (!maps.incomingByUuid[tid]) maps.incomingByUuid[tid] = [];
    maps.incomingByUuid[tid].push({ srcPart: srcInfo.part, srcXCenter: srcInfo.xCenter });
  }

  for (const rb of rootBoxes) {
    const srcPart = parseInt(rb.dataset.row || "0", 10);
    const srcXCenter = rb.offsetLeft + rb.offsetWidth / 2;
    sortLevel(rb, rb.offsetTop, srcPart, srcXCenter, maps);
  }
}

type VDir = "up" | "mid" | "down";
type HDir = "left" | "center" | "right";

interface ClassifiedChild {
  el: HTMLElement;
  dir: RefDir;
  vDir: VDir;
  hDir: HDir;
}

interface SortResult { dir: RefDir; hDir: HDir }

function sortLevel(
  parent: HTMLElement, rootY: number, srcPart: number, srcXCenter: number, maps: RootMaps
): SortResult {
  const childrenDiv = parent.querySelector(":scope > .obj-children");
  if (!childrenDiv) return { dir: "none", hDir: "center" };

  const children = Array.from(childrenDiv.children) as HTMLElement[];
  const classified: ClassifiedChild[] = [];
  let leftCount = 0;
  let rightCount = 0;

  for (const child of children) {
    if (child.classList.contains("obj-ref")) {
      const info = classifyRef(child, rootY, srcPart, maps);
      let vDir: VDir = "mid";
      if (info.dir === "up") vDir = "up";
      else if (info.dir === "down") vDir = "down";

      let hDir: HDir = "center";
      if (info.rowDist > 1) {
        const targetX = info.targetXCenter ?? srcXCenter;
        if (targetX < srcXCenter) { hDir = "left"; leftCount++; }
        else if (targetX > srcXCenter) { hDir = "right"; rightCount++; }
        else if (leftCount <= rightCount) { hDir = "left"; leftCount++; }
        else { hDir = "right"; rightCount++; }
      }

      classified.push({ el: child, dir: info.dir, vDir, hDir });
    } else if (child.classList.contains("obj-box")) {
      const result = sortLevel(child, rootY, srcPart, srcXCenter, maps);
      let vDir: VDir = "mid";
      if (result.dir === "up") vDir = "up";
      else if (result.dir === "down") vDir = "down";
      let hDir = result.hDir;
      const boxUuid = child.dataset.uuid;
      const incoming = boxUuid ? maps.incomingByUuid[boxUuid] : undefined;
      if (incoming && incoming.length > 0) {
        if (hDir === "center") {
          const avgX = incoming.reduce((s, r) => s + r.srcXCenter, 0) / incoming.length;
          if (srcXCenter > avgX) { hDir = "right"; rightCount++; }
          else if (srcXCenter < avgX) { hDir = "left"; leftCount++; }
          else if (leftCount <= rightCount) { hDir = "left"; leftCount++; }
          else { hDir = "right"; rightCount++; }
        }
      }
      classified.push({ el: child, dir: result.dir, vDir, hDir });
    } else {
      classified.push({ el: child, dir: "none", vDir: "mid", hDir: "center" });
    }
  }

  childrenDiv.innerHTML = "";

  for (const c of classified) {
    if (c.hDir !== "center") c.el.dataset.hdir = c.hDir;
    else delete c.el.dataset.hdir;
  }

  const center = classified.filter(c => c.hDir === "center");
  const sideUp = classified.filter(c => c.hDir !== "center" && c.vDir === "up");
  const sideMid = classified.filter(c => c.hDir !== "center" && c.vDir === "mid");
  const sideDown = classified.filter(c => c.hDir !== "center" && c.vDir === "down");

  const up = center.filter(c => c.vDir === "up");
  const mid = center.filter(c => c.vDir === "mid");
  const down = center.filter(c => c.vDir === "down");

  const hasRows = up.length > 0 || down.length > 0 || sideUp.length > 0 || sideDown.length > 0;

  if (hasRows) {
    const makeRow = (items: ClassifiedChild[], cls: string) => {
      if (items.length === 0) return;
      const row = document.createElement("div");
      row.className = "child-row " + cls;
      for (const { el } of items) row.appendChild(el);
      childrenDiv.appendChild(row);
    };
    makeRow(up, "out-up");
    for (const { el } of sideUp) childrenDiv.appendChild(el);
    makeRow(mid, "internal");
    for (const { el } of sideMid) childrenDiv.appendChild(el);
    makeRow(down, "out-down");
    for (const { el } of sideDown) childrenDiv.appendChild(el);
  } else {
    for (const { el } of classified) childrenDiv.appendChild(el);
  }

  const dirs = new Set(classified.map(c => c.dir));
  dirs.delete("none");
  const dir: RefDir = dirs.size === 0 ? "none" : dirs.size === 1 ? dirs.values().next().value as RefDir : "mixed";

  const sideChildren = classified.filter(c => c.hDir !== "center");
  let dominantH: HDir = "center";
  if (sideChildren.length > 0) {
    const leftN = sideChildren.filter(c => c.hDir === "left").length;
    const rightN = sideChildren.filter(c => c.hDir === "right").length;
    dominantH = rightN >= leftN ? "right" : "left";
  }

  return { dir, hDir: dominantH };
}

function classifyRef(
  ref: HTMLElement, rootY: number, srcPart: number, maps: RootMaps
): { dir: RefDir; rowDist: number; targetXCenter: number | null } {
  const tid = ref.dataset.refTarget;
  if (!tid) return { dir: "none", rowDist: 0, targetXCenter: null };
  const ty = maps.yByUuid[tid];
  if (ty === undefined || ty === rootY) return { dir: "none", rowDist: 0, targetXCenter: null };
  const tgtPart = maps.partByUuid[tid] ?? srcPart;
  const rowDist = Math.abs(tgtPart - srcPart);
  const targetXCenter = maps.xByUuid[tid] ?? null;
  return { dir: ty < rootY ? "up" : "down", rowDist, targetXCenter };
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

  for (const edge of edges) {
    const rowDelta = Math.abs(edge.srcPartition - edge.tgtPartition);
    const srcAbove = edge.srcPartition < edge.tgtPartition;

    if (rowDelta === 1) {
      // Single-row hop: top/bottom faces
      if (srcAbove) {
        getFace(edge.srcEl).bottom.push(edge);
        getFace(edge.tgtEl).top.push(edge);
      } else {
        getFace(edge.srcEl).top.push(edge);
        getFace(edge.tgtEl).bottom.push(edge);
      }
    } else {
      // Same-row or multi-row: side faces based on root box x-centers
      const srcRootRect = elRect(edge.srcRoot, hRect, scrollLeft, scrollTop);
      const tgtRootRect = elRect(edge.tgtRoot, hRect, scrollLeft, scrollTop);
      const srcRootCx = srcRootRect.x + srcRootRect.w / 2;
      const tgtRootCx = tgtRootRect.x + tgtRootRect.w / 2;

      let side: "left" | "right";
      if (tgtRootCx < srcRootCx) {
        side = "left";
      } else if (tgtRootCx > srcRootCx) {
        side = "right";
      } else {
        const srcFace = getFace(edge.srcEl);
        side = srcFace.left.length <= srcFace.right.length ? "left" : "right";
      }

      getFace(edge.srcEl)[side].push(edge);
      getFace(edge.tgtEl)[side].push(edge);
    }
  }

  // Compute slot positions for each face of each element
  type SlotMap = Map<Element, Map<Face, Map<RoutedEdge, number>>>;
  const slotPositions: SlotMap = new Map();

  for (const [el, faces] of faceEdges) {
    const rect = elRect(el, hRect, scrollLeft, scrollTop);
    const elSlots = new Map<Face, Map<RoutedEdge, number>>();

    for (const face of ["top", "bottom", "left", "right"] as Face[]) {
      const edgeList = faces[face];
      if (edgeList.length === 0) continue;

      const length = (face === "top" || face === "bottom") ? rect.w : rect.h;
      const spacing = length / (edgeList.length + 1);
      const map = new Map<RoutedEdge, number>();

      for (let i = 0; i < edgeList.length; i++) {
        map.set(edgeList[i], spacing * (i + 1));
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

  // Collect all root box rects for channel allocation
  const rootRects: Rect[] = [];
  for (const rb of allRootBoxes) {
    rootRects.push(elRect(rb, hRect, scrollLeft, scrollTop));
  }

  // Channel allocator: tracks used channel positions to avoid overlap
  const usedChannelX = new Set<number>();
  const usedChannelY = new Set<number>();

  function allocateChannelX(preferredX: number): number {
    let x = Math.round(preferredX);
    while (usedChannelX.has(x)) x += CHANNEL_SPACING;
    usedChannelX.add(x);
    return x;
  }

  function allocateChannelY(preferredY: number): number {
    let y = Math.round(preferredY);
    while (usedChannelY.has(y)) y += CHANNEL_SPACING;
    usedChannelY.add(y);
    return y;
  }

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const rowDelta = Math.abs(edge.srcPartition - edge.tgtPartition);
    const srcAbove = edge.srcPartition < edge.tgtPartition;

    if (rowDelta === 1) {
      // Single-row hop: bottom of upper → top of lower
      const srcFace: Face = srcAbove ? "bottom" : "top";
      const tgtFace: Face = srcAbove ? "top" : "bottom";

      const start = getAnchor(edge.srcEl, srcFace, edge);
      const end = getAnchor(edge.tgtEl, tgtFace, edge);

      if (Math.abs(start.x - end.x) < 1) {
        paths.push({ pts: [start, end], targetUuid: edge.targetUuid, id: "edge_" + i });
      } else {
        const midY = allocateChannelY(Math.round((start.y + end.y) / 2));
        paths.push({
          pts: [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
          targetUuid: edge.targetUuid,
          id: "edge_" + i,
        });
      }
    } else {
      // Same-row or multi-row: side faces, use root box x-centers for side
      const srcRootRect = elRect(edge.srcRoot, hRect, scrollLeft, scrollTop);
      const tgtRootRect = elRect(edge.tgtRoot, hRect, scrollLeft, scrollTop);
      const srcRootCx = srcRootRect.x + srcRootRect.w / 2;
      const tgtRootCx = tgtRootRect.x + tgtRootRect.w / 2;

      let side: "left" | "right";
      if (tgtRootCx < srcRootCx) side = "left";
      else if (tgtRootCx > srcRootCx) side = "right";
      else {
        const srcFaces = faceEdges.get(edge.srcEl);
        side = (srcFaces && srcFaces.left.length <= srcFaces.right.length) ? "left" : "right";
      }

      const start = getAnchor(edge.srcEl, side, edge);
      const end = getAnchor(edge.tgtEl, side, edge);

      if (rowDelta === 0) {
        // Same-row: route below the row
        const maxBottom = Math.max(srcRootRect.y + srcRootRect.h, tgtRootRect.y + tgtRootRect.h);
        const channelY = allocateChannelY(maxBottom + 20);
        paths.push({
          pts: [start, { x: start.x, y: channelY }, { x: end.x, y: channelY }, end],
          targetUuid: edge.targetUuid,
          id: "edge_" + i,
        });
      } else {
        // Multi-row: route through vertical channel outside all root boxes
        let channelX: number;
        if (side === "left") {
          const minX = Math.min(...rootRects.map(r => r.x));
          channelX = allocateChannelX(minX - 20);
        } else {
          const maxX = Math.max(...rootRects.map(r => r.x + r.w));
          channelX = allocateChannelX(maxX + 20);
        }
        paths.push({
          pts: [start, { x: channelX, y: start.y }, { x: channelX, y: end.y }, end],
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
