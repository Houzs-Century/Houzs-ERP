// The project stage tracker's rule, shared by the stepper on the project page
// and Project Overview's event list (one logic layer, owner 2026-10-17: "group
// the events by the project stage").
//
// Auto-detected 10-step timeline (Floorplan → Done) with T-offset deadlines from
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
  // Driver Info — the delivery crew for the event. Goes green when the Setup &
  // Dismantle crew editor arranges the delivery (names a driver/helper, or an
  // outsourced trip — driverKeyedOf on the setup_crew JSON), NOT a checklist
  // document (kind: "driver"). Was wired to
  // "Stock In Transfer Record", but that is the +2 post-dismantle goods-return
  // doc (mig 091), so every upcoming event sat here until long after the event
  // even once the driver/helper were keyed (owner 2026-10-27). That document
  // now lives in the "Stock In" step at the end, where it belongs.
  { label: "Driver Info", offset: -3, titles: [], kind: "driver" },
  // Setup/Dismantle crew arrangement — not a checklist item; goes green
  // when the Setup & Dismantle section is filled (kind: "crew").
  { label: "Setup/Dismantle", offset: -2, titles: [], kind: "crew" },
  { label: "Setup Image", offset: 0, titles: ["Setup Image"] },
  { label: "Filled Floorplan", offset: 3, titles: ["Filled Floorplan"] },
  { label: "Event Complete", offset: 7, titles: ["Event Complete Image"] },
  // Stock In Transfer Record — goods returned to the warehouse after dismantle
  // (template due_offset +2). The last document; it cannot be done before the
  // event, so it is a post-event step at the end, not a pre-event gate.
  { label: "Stock In", offset: 9, titles: ["Stock In Transfer Record"] },
  { label: "Done", offset: 9, titles: [] },
];

/** Setup is "arranged" when a setup time is set OR the setup crew JSON holds
 *  anything (dismantle may be left empty = same as setup). */
export function setupArrangedOf(setupCrew: string | null | undefined, setupStartAt: string | null | undefined): boolean {
  return !!setupStartAt || (!!setupCrew && !["", "{}"].includes(setupCrew.trim()));
}

/** "Driver Info" is keyed once the Setup & Dismantle crew JSON (setup_crew)
 *  arranges the delivery — either an in-house crew or an outsourced trip:
 *   - a named driver or helper, flat ({drivers,helpers}) or per lorry
 *     ({lorry_crew:[{drivers,helpers}]}); a person counts with a non-blank name
 *     (object {name,…}) or a non-blank string; OR
 *   - an outsourced trip ({outsourced:{enabled:true, entries:[{name,plate,…}]}})
 *     whose entry names a provider/driver or a lorry plate (Lalamove / an
 *     outside lorry — no in-house driver, but the transport IS arranged). */
export function driverKeyedOf(setupCrew: string | null | undefined): boolean {
  const raw = (setupCrew ?? "").trim();
  if (!raw || raw === "{}") return false;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!j || typeof j !== "object") return false;
  const nonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  const named = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.some((p) => (typeof p === "string" ? p.trim() !== "" : !!p && typeof p === "object" && nonBlank((p as { name?: unknown }).name)));
  const o = j as { drivers?: unknown; helpers?: unknown; lorry_crew?: unknown; outsourced?: unknown };
  if (named(o.drivers) || named(o.helpers)) return true;
  if (Array.isArray(o.lorry_crew) && o.lorry_crew.some((l) => !!l && typeof l === "object" && (named((l as { drivers?: unknown }).drivers) || named((l as { helpers?: unknown }).helpers)))) return true;
  const out = o.outsourced as { enabled?: unknown; entries?: unknown } | undefined;
  if (out && out.enabled === true && Array.isArray(out.entries)) {
    return out.entries.some((e) => !!e && typeof e === "object" && (nonBlank((e as { name?: unknown }).name) || nonBlank((e as { plate?: unknown }).plate)));
  }
  return false;
}

type Item = { title: string; status?: string | null; review_status?: string | null };

/** The current step (first not done; the last index when all are done), and,
 *  given a start date and today (YYYY-MM-DD), how many days past its deadline. */
export function projectStage(items: Item[], setupArranged: boolean, driverKeyed: boolean, startDate: string | null | undefined, today: string) {
  const stepDone = (idx: number): boolean => {
    const st = PROJECT_STAGES[idx]!;
    if (st.kind === "driver") return driverKeyed;
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
