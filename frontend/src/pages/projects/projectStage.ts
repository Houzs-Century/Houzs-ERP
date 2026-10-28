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

export const PROJECT_STAGES: { label: string; offset: number; titles: string[]; kind?: "crew" }[] = [
  { label: "Floorplan", offset: -21, titles: ["Blank Floorplan"] },
  { label: "3D", offset: -14, titles: ["3D Design"] },
  // "Stocks Request" retired — the "Stocks Request Listing" item was
  // removed, so the step is dropped from the tracker.
  { label: "Stocks Transfer", offset: -7, titles: ["Stock Out Transfer Record"] },
  { label: "Driver Info", offset: -3, titles: ["Stock In Transfer Record"] },
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

type Item = { title: string; status?: string | null; review_status?: string | null };

/** The current step (first not done; the last index when all are done), and,
 *  given a start date and today (YYYY-MM-DD), how many days past its deadline. */
export function projectStage(items: Item[], setupArranged: boolean, startDate: string | null | undefined, today: string) {
  const stepDone = (idx: number): boolean => {
    const st = PROJECT_STAGES[idx]!;
    if (st.kind === "crew") return setupArranged;
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
