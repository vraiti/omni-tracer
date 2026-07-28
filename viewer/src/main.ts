import "./style.css";
import { initTooltip } from "./tooltip";
import { initEdges, scheduleEdgeLayout } from "./edges";
import { initRender, render, buildAndRender } from "./render";
import { initPanels, updateExcludeBtn, updatePinRootBtn, updateEntrypointBtn } from "./panels";
import { initLoader, loadFile, loadFromUrl } from "./loader";
import { getLastTrace, resetConfig } from "./state";

initTooltip();
initEdges();
initRender();
initPanels();
initLoader();

const dropZone = document.getElementById("drop-zone")!;
const fileInputDrop = document.getElementById("file-input-drop") as HTMLInputElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const filterInput = document.getElementById("filter-input") as HTMLInputElement;
const showIsolated = document.getElementById("show-isolated") as HTMLInputElement;

dropZone.addEventListener("click", () => fileInputDrop.click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer?.files.length) loadFile(e.dataTransfer.files[0]);
});

fileInputDrop.addEventListener("change", () => { if (fileInputDrop.files?.length) loadFile(fileInputDrop.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files?.length) loadFile(fileInput.files[0]); });

document.getElementById("reset-layout-btn")!.addEventListener("click", () => {
  resetConfig();
  updateExcludeBtn();
  updatePinRootBtn();
  updateEntrypointBtn();
  buildAndRender();
});

let filterTimeout: ReturnType<typeof setTimeout> | null = null;
filterInput.addEventListener("input", () => {
  if (filterTimeout !== null) clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => { render(); }, 200);
});
showIsolated.addEventListener("change", render);

window.addEventListener("resize", scheduleEdgeLayout);
window.addEventListener("scroll", scheduleEdgeLayout, true);

const traceParam = new URLSearchParams(window.location.search).get("trace") || getLastTrace();
if (traceParam) {
  loadFromUrl("/" + traceParam);
}
