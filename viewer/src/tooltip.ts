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

  let html = `<span class="tt-key">class:</span> <span class="tt-val">${getClassName(obj.ref)}</span><br>`;
  html += `<span class="tt-key">file:</span> <span class="tt-val">${obj.ref.split(":").slice(0, -1).join(":")}</span><br>`;
  html += `<span class="tt-key">uuid:</span> <span class="tt-val">${uuid}</span><br>`;
  html += `<span class="tt-key">owns:</span> <span class="tt-val">${ownedUuids.length} object${ownedUuids.length !== 1 ? "s" : ""}</span><br>`;
  html += `<span class="tt-key">owned by:</span> <span class="tt-val">${parents.length > 0 ? parents.map(p => getClassName(traceData![p].ref)).join(", ") : "none (root)"}</span>`;
  if (backRefs.length > 0) {
    html += `<br><span class="tt-key">back-refs:</span> <span class="tt-val">${backRefs.map(p => getClassName(traceData![p].ref)).join(", ")}</span>`;
  }

  tooltipEl.innerHTML = html;
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
