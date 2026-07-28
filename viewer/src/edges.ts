import ELK from "elkjs/lib/elk.bundled.js";
import type { Point, Rect, EdgePath, EdgeInfo } from "./types";

const elk = new ELK();
const EDGE_OFFSET_PX = 5;
let edgeLayoutTimer: ReturnType<typeof setTimeout> | null = null;

let hierarchyEl: HTMLElement;

export function initEdges(): void {
  hierarchyEl = document.getElementById("hierarchy")!;
}

export function scheduleEdgeLayout(): void {
  if (edgeLayoutTimer !== null) clearTimeout(edgeLayoutTimer);
  edgeLayoutTimer = setTimeout(layoutEdges, 100);
}

function findRootBox(el: Element): Element | null {
  let node = el.closest(".obj-box");
  while (node) {
    if (node.parentElement && node.parentElement.classList.contains("process-children")) return node;
    node = node.parentElement ? node.parentElement.closest(".obj-box") : null;
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

type Side = "left" | "right" | "top" | "bottom";

function nearestSide(innerPt: Point, box: Rect): Side {
  const dLeft = innerPt.x - box.x;
  const dRight = (box.x + box.w) - innerPt.x;
  const dTop = innerPt.y - box.y;
  const dBottom = (box.y + box.h) - innerPt.y;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dRight) return "right";
  if (min === dLeft) return "left";
  if (min === dBottom) return "bottom";
  return "top";
}

function sideExitPoint(box: Rect, side: Side, offset: number): Point {
  switch (side) {
    case "right": return { x: box.x + box.w, y: box.y + box.h / 2 + offset };
    case "left": return { x: box.x, y: box.y + box.h / 2 + offset };
    case "bottom": return { x: box.x + box.w / 2 + offset, y: box.y + box.h };
    case "top": return { x: box.x + box.w / 2 + offset, y: box.y };
  }
}

function boxEdgePoint(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return { x: cx, y: cy };
  const scaleX = rect.w / 2 / Math.abs(dx || 1);
  const scaleY = rect.h / 2 / Math.abs(dy || 1);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function orthogonalToSide(pt: Point, exitPt: Point, side: Side): Point[] {
  if (side === "right" || side === "left") {
    return [pt, { x: exitPt.x, y: pt.y }, { x: exitPt.x, y: exitPt.y }];
  }
  return [pt, { x: pt.x, y: exitPt.y }, { x: exitPt.x, y: exitPt.y }];
}

interface OffsetEntry {
  edge: ElkEdgeExt;
  sortKey: number;
  offset: number;
}

interface ElkEdgeExt {
  id: string;
  sources: string[];
  targets: string[];
  info: EdgeInfo;
  _srcSide?: Side;
  _tgtSide?: Side;
  _elkEdge?: { sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[] };
}

function assignOffsets(edgeGroups: Record<string, OffsetEntry[]>): void {
  for (const edges of Object.values(edgeGroups)) {
    const n = edges.length;
    if (n === 0) continue;
    edges.sort((a, b) => a.sortKey - b.sortKey);
    const half = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      edges[i].offset = (i - half) * EDGE_OFFSET_PX;
    }
  }
}

function layoutEdges(): void {
  const refEls = hierarchyEl.querySelectorAll(".obj-ref[data-ref-target]");
  if (refEls.length === 0) { clearEdgeSvg(); return; }

  const hRect = hierarchyEl.getBoundingClientRect();
  const scrollLeft = hierarchyEl.scrollLeft || 0;
  const scrollTop = hierarchyEl.scrollTop || 0;

  const edgeInfos: EdgeInfo[] = [];

  for (const refEl of refEls) {
    const targetUuid = (refEl as HTMLElement).dataset.refTarget;
    if (!targetUuid) continue;
    const targetEl = hierarchyEl.querySelector(`.obj-box[data-uuid="${targetUuid}"]`);
    if (!targetEl) continue;

    const srcRoot = findRootBox(refEl);
    const tgtRoot = findRootBox(targetEl);
    if (!srcRoot || !tgtRoot) continue;

    edgeInfos.push({
      refEl,
      targetEl,
      targetUuid,
      srcRoot,
      tgtRoot,
      sameRoot: srcRoot === tgtRoot,
      refRect: elRect(refEl, hRect, scrollLeft, scrollTop),
      tgtRect: elRect(targetEl, hRect, scrollLeft, scrollTop),
      srcRootRect: elRect(srcRoot, hRect, scrollLeft, scrollTop),
      tgtRootRect: elRect(tgtRoot, hRect, scrollLeft, scrollTop),
    });
  }

  if (edgeInfos.length === 0) { clearEdgeSvg(); return; }

  const crossEdges = edgeInfos.filter(e => !e.sameRoot);
  const sameEdges = edgeInfos.filter(e => e.sameRoot);

  const rootBoxMap = new Map<Element, { id: string; rect: Rect }>();
  const allRootBoxes = hierarchyEl.querySelectorAll(":scope > .process-box > .process-children > .obj-box");
  let rbIdx = 0;
  for (const rb of allRootBoxes) {
    if (!rootBoxMap.has(rb)) {
      rootBoxMap.set(rb, { id: "rb_" + rbIdx++, rect: elRect(rb, hRect, scrollLeft, scrollTop) });
    }
  }

  const elkEdges: ElkEdgeExt[] = crossEdges.map((e, i) => ({
    id: "e_" + i,
    sources: [rootBoxMap.get(e.srcRoot)!.id],
    targets: [rootBoxMap.get(e.tgtRoot)!.id],
    info: e,
  }));

  const NODE_PADDING = 8;
  const elkNodes: { id: string; x: number; y: number; width: number; height: number }[] = [];
  for (const [, { id, rect }] of rootBoxMap) {
    elkNodes.push({
      id,
      x: rect.x - NODE_PADDING,
      y: rect.y - NODE_PADDING,
      width: rect.w + NODE_PADDING * 2,
      height: rect.h + NODE_PADDING * 2,
    });
  }

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "fixed",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.edgeEdge": "8",
      "elk.spacing.edgeNode": "12",
      "elk.spacing.nodeNode": "16",
    },
    children: elkNodes,
    edges: elkEdges.map(e => ({ id: e.id, sources: e.sources, targets: e.targets })),
  };

  elk.layout(elkGraph).then(result => {
    const elkEdgeMap: Record<string, typeof result.edges extends (infer E)[] | undefined ? E : never> = {};
    if (result.edges) for (const e of result.edges) elkEdgeMap[e.id] = e;

    const srcExitGroups: Record<string, OffsetEntry[]> = {};
    const tgtEntryGroups: Record<string, OffsetEntry[]> = {};

    for (const ee of elkEdges) {
      const info = ee.info;
      const srcCenter: Point = { x: info.refRect.x + info.refRect.w / 2, y: info.refRect.y + info.refRect.h / 2 };
      const tgtCenter: Point = { x: info.tgtRect.x + info.tgtRect.w / 2, y: info.tgtRect.y + info.tgtRect.h / 2 };

      const elkEdge = elkEdgeMap[ee.id];
      let firstExtPt: Point;
      let _lastExtPt: Point;
      if (elkEdge && (elkEdge as Record<string, unknown>).sections) {
        const sections = (elkEdge as Record<string, unknown>).sections as { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
        if (sections.length > 0) {
          const sec = sections[0];
          firstExtPt = sec.bendPoints && sec.bendPoints.length > 0 ? sec.bendPoints[0] : sec.endPoint;
          _lastExtPt = sec.bendPoints && sec.bendPoints.length > 0 ? sec.bendPoints[sec.bendPoints.length - 1] : sec.startPoint;
        } else {
          firstExtPt = tgtCenter;
          _lastExtPt = srcCenter;
        }
      } else {
        firstExtPt = tgtCenter;
        _lastExtPt = srcCenter;
      }
      void firstExtPt;
      void _lastExtPt;

      const srcSide = nearestSide(srcCenter, info.srcRootRect);
      const tgtSide = nearestSide(tgtCenter, info.tgtRootRect);

      const srcKey = rootBoxMap.get(info.srcRoot)!.id + "_" + srcSide;
      const tgtKey = rootBoxMap.get(info.tgtRoot)!.id + "_" + tgtSide;

      if (!srcExitGroups[srcKey]) srcExitGroups[srcKey] = [];
      srcExitGroups[srcKey].push({
        edge: ee,
        sortKey: (srcSide === "top" || srcSide === "bottom") ? srcCenter.x : srcCenter.y,
        offset: 0,
      });

      if (!tgtEntryGroups[tgtKey]) tgtEntryGroups[tgtKey] = [];
      tgtEntryGroups[tgtKey].push({
        edge: ee,
        sortKey: (tgtSide === "top" || tgtSide === "bottom") ? tgtCenter.x : tgtCenter.y,
        offset: 0,
      });

      ee._srcSide = srcSide;
      ee._tgtSide = tgtSide;
      ee._elkEdge = elkEdge as ElkEdgeExt["_elkEdge"];
    }

    assignOffsets(srcExitGroups);
    assignOffsets(tgtEntryGroups);

    const srcOffsetMap: Record<string, number> = {};
    for (const entries of Object.values(srcExitGroups))
      for (const entry of entries) srcOffsetMap[entry.edge.id] = entry.offset;
    const tgtOffsetMap: Record<string, number> = {};
    for (const entries of Object.values(tgtEntryGroups))
      for (const entry of entries) tgtOffsetMap[entry.edge.id] = entry.offset;

    const paths: EdgePath[] = [];

    for (const ee of elkEdges) {
      const info = ee.info;
      const exitPt = sideExitPoint(info.srcRootRect, ee._srcSide!, srcOffsetMap[ee.id] || 0);
      const entryPt = sideExitPoint(info.tgtRootRect, ee._tgtSide!, tgtOffsetMap[ee.id] || 0);
      const srcEdge = boxEdgePoint(info.refRect, exitPt);
      const tgtEdge = boxEdgePoint(info.tgtRect, entryPt);
      const srcPath = orthogonalToSide(srcEdge, exitPt, ee._srcSide!);
      const tgtPath = orthogonalToSide(tgtEdge, entryPt, ee._tgtSide!).reverse();

      let midPath: Point[] = [];
      const elkE = ee._elkEdge;
      if (elkE && elkE.sections && elkE.sections.length > 0) {
        const sec = elkE.sections[0];
        if (sec.bendPoints) midPath = sec.bendPoints.map(p => ({ x: p.x, y: p.y }));
      }

      const allPts = [...srcPath, ...midPath, ...tgtPath];
      const clean = [allPts[0]];
      for (let i = 1; i < allPts.length; i++) {
        const prev = clean[clean.length - 1];
        if (Math.abs(prev.x - allPts[i].x) > 0.5 || Math.abs(prev.y - allPts[i].y) > 0.5) {
          clean.push(allPts[i]);
        }
      }

      paths.push({ pts: clean, targetUuid: info.targetUuid, id: ee.id });
    }

    for (const se of sameEdges) {
      const midX = Math.max(se.refRect.x + se.refRect.w, se.tgtRect.x + se.tgtRect.w) + 20;
      const srcEdge = boxEdgePoint(se.refRect, { x: midX, y: se.refRect.y + se.refRect.h / 2 });
      const tgtEdge = boxEdgePoint(se.tgtRect, { x: midX, y: se.tgtRect.y + se.tgtRect.h / 2 });
      paths.push({
        pts: [srcEdge, { x: midX, y: srcEdge.y }, { x: midX, y: tgtEdge.y }, tgtEdge],
        targetUuid: se.targetUuid,
        id: "same_" + paths.length,
      });
    }

    drawPaths(paths);
  }).catch(() => {
    const paths: EdgePath[] = [];
    for (const info of edgeInfos) {
      const midX = Math.max(info.refRect.x + info.refRect.w, info.tgtRect.x + info.tgtRect.w) + 20;
      const srcEdge = boxEdgePoint(info.refRect, { x: midX, y: info.refRect.y + info.refRect.h / 2 });
      const tgtEdge = boxEdgePoint(info.tgtRect, { x: midX, y: info.tgtRect.y + info.tgtRect.h / 2 });
      paths.push({
        pts: [srcEdge, { x: midX, y: srcEdge.y }, { x: midX, y: tgtEdge.y }, tgtEdge],
        targetUuid: info.targetUuid,
        id: "fb_" + paths.length,
      });
    }
    drawPaths(paths);
  });
}

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
    (path as SVGElement & { dataset: DOMStringMap }).dataset.edgeId = p.id;
    (path as SVGElement & { dataset: DOMStringMap }).dataset.targetUuid = p.targetUuid;
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
    if ((path as HTMLElement).dataset.targetUuid === targetUuid) {
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
