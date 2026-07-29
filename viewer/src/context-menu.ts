import {
  traceData, excludedClasses, pinnedRootClasses, rootOrder,
  ownershipOverrides, saveConfig,
} from "./state";
import { getClassName } from "./graph";
import { render, buildAndRender } from "./render";
import { updateExcludeBtn, updatePinRootBtn, updateRootOrderBtn } from "./panels";

let menuEl: HTMLDivElement | null = null;

function hide(): void {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

function show(x: number, y: number, items: { label: string; checked: boolean; action: () => void }[]): void {
  hide();
  menuEl = document.createElement("div");
  menuEl.className = "context-menu";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "context-menu-item";
    row.textContent = (item.checked ? "✓ " : "  ") + item.label;
    row.addEventListener("click", e => {
      e.stopPropagation();
      hide();
      item.action();
    });
    menuEl.appendChild(row);
  }

  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - rect.width - 4) + "px";
  menuEl.style.top = Math.min(y, window.innerHeight - rect.height - 4) + "px";
}

export function initContextMenu(): void {
  const hierarchy = document.getElementById("hierarchy")!;

  hierarchy.addEventListener("contextmenu", e => {
    const target = e.target as HTMLElement;
    const refEl = target.closest(".obj-ref") as HTMLElement | null;
    const boxEl = (refEl || target.closest(".obj-box")) as HTMLElement | null;
    if (!boxEl) return;
    e.preventDefault();

    const isRef = !!refEl;
    const nodeId = isRef ? refEl.dataset.refTarget : boxEl.dataset.nodeId;
    if (!nodeId || !traceData) return;
    const obj = traceData[nodeId];
    if (!obj) return;
    const className = getClassName(obj.ref);

    const items: { label: string; checked: boolean; action: () => void }[] = [
      {
        label: "Exclude " + className,
        checked: excludedClasses.has(className),
        action: () => {
          if (excludedClasses.has(className)) excludedClasses.delete(className);
          else excludedClasses.add(className);
          saveConfig();
          updateExcludeBtn();
          render();
        },
      },
      {
        label: "Pin " + className + " as root",
        checked: pinnedRootClasses.has(className),
        action: () => {
          if (pinnedRootClasses.has(className)) pinnedRootClasses.delete(className);
          else pinnedRootClasses.add(className);
          saveConfig();
          updatePinRootBtn();
          buildAndRender();
        },
      },
      {
        label: className in rootOrder ? "Remove rank for " + className : "Set rank for " + className,
        checked: className in rootOrder,
        action: () => {
          if (className in rootOrder) {
            delete rootOrder[className];
          } else {
            const vals = Object.values(rootOrder);
            rootOrder[className] = vals.length > 0 ? Math.max(...vals) + 1 : 0;
          }
          saveConfig();
          updateRootOrderBtn();
          buildAndRender();
        },
      },
    ];

    if (isRef && refEl) {
      const parentBox = refEl.closest(".obj-box") as HTMLElement | null;
      const parentId = parentBox?.dataset.nodeId;
      const refTarget = refEl.dataset.refTarget;
      if (parentId && refTarget && traceData && traceData[refTarget]) {
        const isTransferred = ownershipOverrides[refTarget] === parentId;
        items.push({
          label: "Transfer ownership here",
          checked: isTransferred,
          action: () => {
            if (isTransferred) delete ownershipOverrides[refTarget];
            else ownershipOverrides[refTarget] = parentId;
            traceData![refTarget].created_by = ownershipOverrides[refTarget] ?? undefined;
            saveConfig();
            buildAndRender();
          },
        });
      }
    }

    show(e.clientX, e.clientY, items);
  });

  document.addEventListener("click", hide);
  document.addEventListener("contextmenu", e => {
    if (!(e.target as HTMLElement).closest("#hierarchy")) hide();
  });
}
