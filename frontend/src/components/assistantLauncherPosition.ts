
import { identityStorageKey } from "../lib/storageIdentity";

export const STORAGE_KEY = "houzs:assistant-launcher-pos";
export const assistantLauncherStorageKey = () => identityStorageKey(STORAGE_KEY);

export const DRAG_THRESHOLD_PX = 6;

export const EDGE_MARGIN_PX = 8;

export const DISC_SIZE_PX = 56;

export interface Offset {
  right: number;
  bottom: number;
}

export const DEFAULT_OFFSET: Offset = { right: 80, bottom: 20 };

export function clampOffset(
  off: Offset,
  discW: number,
  discH: number,
  vw: number,
  vh: number,
): Offset {
  const maxRight = Math.max(EDGE_MARGIN_PX, vw - discW - EDGE_MARGIN_PX);
  const maxBottom = Math.max(EDGE_MARGIN_PX, vh - discH - EDGE_MARGIN_PX);
  return {
    right: Math.min(Math.max(off.right, EDGE_MARGIN_PX), maxRight),
    bottom: Math.min(Math.max(off.bottom, EDGE_MARGIN_PX), maxBottom),
  };
}

export function readStoredOffset(): Offset {
  try {
    const key = assistantLauncherStorageKey();
    if (!key) return DEFAULT_OFFSET;
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_OFFSET;
    const parsed = JSON.parse(raw) as Partial<Offset>;
    if (
      typeof parsed?.right === "number" &&
      Number.isFinite(parsed.right) &&
      typeof parsed?.bottom === "number" &&
      Number.isFinite(parsed.bottom)
    ) {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
  }
  return DEFAULT_OFFSET;
}
