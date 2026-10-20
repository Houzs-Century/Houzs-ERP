// The project stage tracker's rule, shared by the stepper on the project page
// and Project Overview's event list (one logic layer, owner 2026-10-17: "group
// the events by the project stage").
//
// Auto-detected 9-step timeline (Floorplan → Done) with T-offset deadlines from
// the project's start date. A step is "done" when its mapped checklist item(s)
// are complete; steps whose items don't exist (e.g. removed from the template)
// are treated as pass-through so they never block. The current step is the
// first not-done one — overdue when today is past its deadline.
import { itemComplete } from "./checklistDone";

export const PROJECT_STAGES: { label: string; offset: number; titles: string[]; kind?: "crew" | "driver" }[] = [
  { label: "Floorplan", offset: -21, titles: ["Blank Floorplan"] },
  { label: "3D", offset: -14, titles: ["3D Design"] },
  // "Stocks Request" retired — the "Stocks Request Listing" item was
  // removed, so the step is dropped from the tracker.
  { label: "Stocks Transfer", offset: -7, titles: ["Stock Out Transfer Record"] },
  // "Driver Info" goes green when a delivery driver is named in the Setup &
  // Dismantle crew (kind: "driver"). It used to gate on the "Stock In Transfer
  // Record" document — the POST-dismantle stock-return form, due +2 — so a
  // −3-day step could only clear AFTER the event; worse, it did nothing at all
  // until that item began existing on every project (mig 091, 2026-08-18),
  // after which every event piled up at this step. Owner 2026-10-21: the step
  // means "is the driver assigned", read from the crew JSON the page already
  // keeps (the Setup/Dismantle step still gates the fuller crew arrangement).
  { label: "Driver Info", offset: -3, titles: [], kind: "driver" },
  // Setup/Dismantle crew arrangement — not a checklist item; goes green
  // when the Setup & Dismantle section is filled (kind: "crew").
  { label: "Setup/Dismantle", offset: -2, titles: [], kind: "crew" },
  { label: "Setup Image", offset: 0, titles: ["Setup Image"] },
  { label: "Filled Floorplan", offset: 3, titles: ["Filled Floorplan"] },
  { label: "Event Complete", offset: 7, titles: ["Event Complete Image"] },
  { label: "Done", offset: 7, titles: [] },
];

/** Setup is "arranged" when a setup time is set OR the setup crew JSON holds
 *  anything (dismantle may be left empty = same as setup). */
export function setupArrangedOf(setupCrew: string | null | undefined, setupStartAt: string | null | undefined): boolean {
  return !!setupStartAt || (!!setupCrew && !["", "{}"].includes(setupCrew.trim()));
}

/** A delivery driver is named in the Setup & Dismantle crew JSON (`setup_crew`)
 *  — the flat `drivers` mirror, any per-lorry `drivers`, or an outsourced
 *  (Outsource / Lalamove) entry carrying a name. Drives the "Driver Info" step.
 *  Tolerant of the legacy flat shape, the lorry_crew shape and of junk JSON. */
export function driverAssignedOf(setupCrew: string | null | undefined): boolean {
  if (!setupCrew) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(setupCrew); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const rec = parsed as Record<string, unknown>;
  const field = (x: unknown, k: string): unknown => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined);
  const named = (a: unknown): boolean =>
    Array.isArray(a) && a.some((x) => { const n = field(x, "name"); return typeof n === "string" && n.trim() !== ""; });
  if (named(rec.drivers)) return true;
  if (Array.isArray(rec.lorry_crew) && rec.lorry_crew.some((l) => named(field(l, "drivers")))) return true;
  if (named(field(rec.outsourced, "entries"))) return true;
  return false;
}

type Item = { title: string; status?: string | null; review_status?: string | null };

/** The current step (first not done; the last index when all are done), and,
 *  given a start date and today (YYYY-MM-DD), how many days past its deadline. */
export function projectStage(items: Item[], setupArranged: boolean, startDate: string | null | undefined, today: string, driverAssigned: boolean) {
  const stepDone = (idx: number): boolean => {
    const st = PROJECT_STAGES[idx]!;
    if (st.kind === "crew") return setupArranged;
    if (st.kind === "driver") return driverAssigned;
    if (st.titles.length === 0) return false; // final "Done" handled below
    const present = items.filter((i) => st.titles.includes(i.title));
    if (present.length === 0) return true; // no signal → pass-through
    return present.every(itemComplete);
  };
  const lastIdx = PROJECT_STAGES.length - 1;
  let currentIdx = PROJECT_STAGES.findIndex((_, i) => i < lastIdx && !stepDone(i));
  const allDone = currentIdx === -1;
  if (allDone) currentIdx = lastIdx;
  const deadline = startDate ? new Date(Date.parse(`${startDate.slice(0, 10)}T00:00:00Z`) + PROJECT_STAGES[currentIdx]!.offset * 86400000).toISOString().slice(0, 10) : null;
  const daysLate = !allDone && deadline && today > deadline ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${deadline}T00:00:00Z`)) / 86400000) : 0;
  return { currentIdx, allDone, lastIdx, deadline, daysLate };
}
