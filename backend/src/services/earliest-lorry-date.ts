/** Earliest per-lorry date in a setup_crew / dismantle_crew JSON blob, or null.
 *  Owner 2026-10-26: the Setup & Dismantle editor dropped the single shared date
 *  box — each lorry carries its own date+time under `lorry_crew[].at`
 *  ("YYYY-MM-DDTHH:mm", which sorts lexically = chronologically). We derive the
 *  earliest so projects.setup_start_at / dismantle_start_at stay populated for
 *  the delivery-planning board, the printed Event Summary and the stage stepper,
 *  which still read one representative window date.
 *
 *  Extracted from projects.ts (behaviour unchanged) only to keep that file under
 *  its size ceiling. */
export function earliestLorryDate(crewJson: unknown): string | null {
  if (typeof crewJson !== "string" || !crewJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(crewJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const lorryCrew = (parsed as { lorry_crew?: unknown }).lorry_crew;
  if (!Array.isArray(lorryCrew)) return null;
  let earliest: string | null = null;
  for (const entry of lorryCrew as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const at = (entry as { at?: unknown }).at;
    if (typeof at !== "string") continue;
    const trimmed = at.trim();
    if (trimmed && (earliest === null || trimmed < earliest)) earliest = trimmed;
  }
  return earliest;
}
