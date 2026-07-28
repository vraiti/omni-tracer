import { traceData, effectiveParentMap, parentMap } from "./state";
import { getClassName, getOwnedUuids } from "./graph";

let tooltipEl: HTMLElement;

export function initTooltip(): void {
  tooltipEl = document.getElementById("tooltip")!;
}

export function showTooltip(e: MouseEvent, uuid: string): void {
  if (!traceData) return;
  const obj = traceData[uuid];
  if (!obj) return;

  const ownedUuids = getOwnedUuids(obj);
  const parents = effectiveParentMap[uuid] || [];
  const backRefs = (parentMap[uuid] || []).filter(p => !parents.includes(p));

  const addLine = (key: string, val: string) => {
    if (tooltipEl.children.length > 0) tooltipEl.appendChild(document.createElement("br"));
    const k = document.createElement("span");
    k.className = "tt-key";
    k.textContent = key + ":";
    const v = document.createElement("span");
    v.className = "tt-val";
    v.textContent = " " + val;
    tooltipEl.appendChild(k);
    tooltipEl.appendChild(v);
  };

  tooltipEl.innerHTML = "";
  addLine("class", getClassName(obj.ref));
  addLine("file", obj.ref.split(":").slice(0, -1).join(":"));
  addLine("uuid", uuid);
  addLine("owns", ownedUuids.length + " object" + (ownedUuids.length !== 1 ? "s" : ""));
  addLine("owned by", parents.length > 0 ? parents.map(p => getClassName(traceData![p].ref)).join(", ") : "none (root)");
  if (backRefs.length > 0) {
    addLine("back-refs", backRefs.map(p => getClassName(traceData![p].ref)).join(", "));
  }
  if (obj.attrs) {
    for (const [k, v] of Object.entries(obj.attrs)) {
      addLine("." + k, v);
    }
  }
  tooltipEl.classList.remove("hidden");
  moveTooltip(e);
}

export function moveTooltip(e: MouseEvent): void {
  let x = e.clientX + 12;
  let y = e.clientY + 12;
  const rect = tooltipEl.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - 12;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - 12;
  tooltipEl.style.left = x + "px";
  tooltipEl.style.top = y + "px";
}

export function hideTooltip(): void {
  tooltipEl.classList.add("hidden");
}
