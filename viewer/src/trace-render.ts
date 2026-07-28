import type { TraceData, FunctionData, Point } from "./types";
import { getClassName } from "./graph";


interface FuncNode {
  fid: string;
  callerFid: string | null;
  objectUuid: string | null;
  isPlain: boolean;
}

function getFuncName(ref: string): string {
  const afterColon = ref.includes(":") ? ref.split(":").pop()! : ref;
  const parts = afterColon.split(".");
  return parts[parts.length - 1];
}

function getFileName(ref: string): string {
  if (ref.includes("/")) {
    const filePart = ref.split(":")[0];
    return filePart.split("/").pop()!;
  }
  return ref.split(":")[0];
}

export function renderTrace(
  rootFid: string,
  functions: FunctionData,
  objects: TraceData,
  container: HTMLElement,
  svgEl: SVGSVGElement,
): void {
  container.innerHTML = "";
  while (svgEl.firstChild) svgEl.firstChild.remove();

  const nodes: FuncNode[] = [];
  const seen = new Set<string>();

  function walk(fid: string, callerFid: string | null, inheritedObj: string | null): void {
    if (seen.has(fid)) return;
    seen.add(fid);
    const fn = functions[fid];
    if (!fn) return;

    let objectUuid = fn.bound_to || null;
    const isPlain = !objectUuid;
    if (!objectUuid) objectUuid = inheritedObj;

    nodes.push({ fid, callerFid, objectUuid, isPlain });

    const nextObj = fn.bound_to || inheritedObj;
    for (const child of fn.invokes) {
      walk(child, fid, nextObj);
    }
  }

  walk(rootFid, null, null);

  const byObject = new Map<string | null, FuncNode[]>();
  const objectOrder: (string | null)[] = [];
  for (const node of nodes) {
    if (!byObject.has(node.objectUuid)) {
      byObject.set(node.objectUuid, []);
      objectOrder.push(node.objectUuid);
    }
    byObject.get(node.objectUuid)!.push(node);
  }

  const funcEls = new Map<string, HTMLElement>();

  for (const objUuid of objectOrder) {
    const group = byObject.get(objUuid)!;

    const objContainer = document.createElement("div");
    objContainer.className = "obj-container";

    if (objUuid && objects[objUuid]) {
      const label = document.createElement("div");
      label.className = "obj-container-label";
      const cls = getClassName(objects[objUuid].ref);
      const shortCls = cls.includes(".") ? cls.split(".").pop()! : cls;
      label.textContent = shortCls;
      label.title = cls;
      objContainer.appendChild(label);
    } else {
      const label = document.createElement("div");
      label.className = "obj-container-label plain";
      label.textContent = "module scope";
      objContainer.appendChild(label);
    }

    const body = document.createElement("div");
    body.className = "obj-container-body";

    for (const node of group) {
      const fn = functions[node.fid]!;
      const box = document.createElement("div");
      box.className = "func-box" + (node.isPlain ? " plain" : "");
      box.dataset.fid = node.fid;

      const name = document.createElement("span");
      name.className = "func-name";
      name.textContent = getFuncName(fn.ref);
      box.appendChild(name);

      if (node.isPlain) {
        const file = document.createElement("span");
        file.className = "func-file";
        file.textContent = getFileName(fn.ref);
        box.appendChild(file);
      }

      body.appendChild(box);
      funcEls.set(node.fid, box);
    }

    objContainer.appendChild(body);
    container.appendChild(objContainer);
  }

  container.style.display = "block";

  requestAnimationFrame(() => {
    drawEdges(nodes, funcEls, container, svgEl);
  });
}

function drawEdges(
  nodes: FuncNode[],
  funcEls: Map<string, HTMLElement>,
  container: HTMLElement,
  svgEl: SVGSVGElement,
): void {
  const cRect = container.getBoundingClientRect();
  const svgNs = "http://www.w3.org/2000/svg";

  let maxX = 0;
  let maxY = 0;

  const edges: { from: DOMRect; to: DOMRect }[] = [];

  for (const node of nodes) {
    if (!node.callerFid) continue;
    const srcEl = funcEls.get(node.callerFid);
    const tgtEl = funcEls.get(node.fid);
    if (!srcEl || !tgtEl) continue;
    edges.push({
      from: srcEl.getBoundingClientRect(),
      to: tgtEl.getBoundingClientRect(),
    });
  }

  for (const { from, to } of edges) {
    const sx = from.right - cRect.left;
    const sy = from.top - cRect.top + from.height / 2;
    const ex = to.left - cRect.left;
    const ey = to.top - cRect.top + to.height / 2;

    maxX = Math.max(maxX, sx, ex);
    maxY = Math.max(maxY, sy, ey);

    const midX = (sx + ex) / 2;

    const pts: Point[] = [
      { x: sx, y: sy },
      { x: midX, y: sy },
      { x: midX, y: ey },
      { x: ex, y: ey },
    ];

    const d = "M" + pts.map(p => p.x + "," + p.y).join(" L");
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", d);
    path.classList.add("trace-edge");
    svgEl.appendChild(path);
  }

  const defs = document.createElementNS(svgNs, "defs");
  const marker = document.createElementNS(svgNs, "marker");
  marker.setAttribute("id", "trace-arrow");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS(svgNs, "path");
  arrow.setAttribute("d", "M0,0 L8,3 L0,6 Z");
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svgEl.insertBefore(defs, svgEl.firstChild);

  for (const path of svgEl.querySelectorAll(".trace-edge")) {
    path.setAttribute("marker-end", "url(#trace-arrow)");
  }

  svgEl.setAttribute("width", String(container.scrollWidth));
  svgEl.setAttribute("height", String(container.scrollHeight));
}

export function findRootCandidates(functions: FunctionData): string[] {
  const called = new Set<string>();
  for (const fn of Object.values(functions)) {
    for (const child of fn.invokes) {
      called.add(child);
    }
  }
  const roots: string[] = [];
  for (const [fid, fn] of Object.entries(functions)) {
    if (!called.has(fid) && fn.invokes.length > 0) {
      roots.push(fid);
    }
  }
  return roots;
}
