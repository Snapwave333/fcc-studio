import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";

export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let current = 1;

export function nextZoom(value: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > value + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < value - 0.001) ?? ZOOM_STEPS[0];
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], value));
}

async function apply(value: number) {
  current = clampZoom(value);
  await getCurrentWebview().setZoom(current);
  await api.kvSet("ui.zoom", String(current)).catch(() => {});
  return current;
}

export async function restoreZoom() {
  const raw = await api.kvGet("ui.zoom").catch(() => null);
  const v = raw ? clampZoom(parseFloat(raw)) : 1;
  if (v !== 1) await apply(v).catch(() => {});
  else current = 1;
}

export const zoomIn = () => apply(nextZoom(current, 1));
export const zoomOut = () => apply(nextZoom(current, -1));
export const zoomReset = () => apply(1);
