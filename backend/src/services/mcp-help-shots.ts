import SHOTS_JSON from "./mcp-help-shots.json";

export type Box = [number, number, number, number];
export type Shot = { file: string; w: number; h: number; boxes: Record<string, Box> };
/** The captured screenshots (scripts/capture-help-shots.mjs), keyed by page. */
export const SHOTS = (SHOTS_JSON as unknown as { shots: Record<string, Shot> }).shots;

/** The note every show_me answer carries. */
export const SHOT_NOTE = "screenshot uses test data, layout is the same";

/** A resolved picture: the page key in mcp-help-shots.json, the label and its box. */
export type ShotHit = { page: string; label: string; shot: Shot; box: Box };

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The box of a label on a page's screenshot, or null. */
export function boxOn(page: string, label: string): ShotHit | null {
  const shot = Object.prototype.hasOwnProperty.call(SHOTS, page) ? SHOTS[page] : null;
  if (!shot) return null;
  const key = Object.keys(shot.boxes).find((k) => norm(k) === norm(label));
  return key ? { page, label: key, shot, box: shot.boxes[key] } : null;
}

/** The first boxed label of a page's screenshot, or null. */
export const firstBox = (page: string): ShotHit | null => {
  const shot = Object.prototype.hasOwnProperty.call(SHOTS, page) ? SHOTS[page] : null;
  const label = shot ? Object.keys(shot.boxes)[0] : undefined;
  return shot && label ? { page, label, shot, box: shot.boxes[label] } : null;
};

/** Is there a picture of this label on this page? (how_to / where_is mention show_me only then.) */
export const hasShot = (page: string, label: string | null): boolean => Boolean(label && boxOn(page, label));

