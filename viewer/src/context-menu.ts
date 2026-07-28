import {
  traceData, excludedClasses, pinnedRootClasses, entrypointClasses, saveConfig,
} from "./state";
import { getClassName } from "./graph";
import { render, buildAndRender } from "./render";
import { updateExcludeBtn, updatePinRootBtn, updateEntrypointBtn } from "./panels";

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
    const uuid = isRef ? refEl.dataset.refTarget : boxEl.dataset.uuid;
    if (!uuid || !traceData) return;
    const obj = traceData[uuid];
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
        label: "Set " + className + " as entrypoint",
        checked: entrypointClasses.has(className),
        action: () => {
          if (entrypointClasses.has(className)) entrypointClasses.delete(className);
          else entrypointClasses.add(className);
          saveConfig();
          updateEntrypointBtn();
          buildAndRender();
        },
      },
    ];

    if (isRef && refEl) {
      const parentBox = refEl.closest(".obj-box") as HTMLElement | null;
      const parentUuid = parentBox?.dataset.uuid;
      const refTarget = refEl.dataset.refTarget;
      if (parentUuid && refTarget && traceData && traceData[refTarget]) {
        const targetObj = traceData[refTarget];
        const isTransferred = targetObj.created_by === parentUuid;
        items.push({
          label: "Transfer ownership here",
          checked: isTransferred,
          action: () => {
            if (isTransferred) delete targetObj.created_by;
            else targetObj.created_by = parentUuid;
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
