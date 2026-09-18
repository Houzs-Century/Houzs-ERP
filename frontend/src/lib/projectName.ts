/**
 * Canonical event-name composer — "STATE [BRAND] ORGANIZER @ VENUE".
 *
 * The project name is DERIVED, never typed: the New Project forms (desktop
 * pages/Projects.tsx and the mobile PMS) both build it from the picked
 * state / brand / organizer / venue so every event reads the same way, and
 * the backend derives the project CODE from the same fields.
 *
 * A SOLO event puts the literal "SOLO" in the organizer slot (there is no
 * external organizer). State leads UPPERCASE (owner 2026-07-24): states are
 * stored Title Case since the 2026-07-22 canonical migration, but the naming
 * convention is all-caps to match the older UPPERCASE-stored names.
 *
 * Kept as its own module so the surfaces cannot drift; pages/Projects.tsx and
 * mobile/MobileCalendar.tsx still carry their own older copies of this logic
 * (identical output) — fold them in here when either file is next touched.
 */
export function composeDefaultProjectName(p: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  event_type_slug?: string | null;
}): string {
  const state = (p.state || "").trim();
  const brand = (p.brand || "").trim();
  const organizer = (p.organizer || "").trim();
  const venue = (p.venue || "").trim();
  const isSolo = (p.event_type_slug || "").toLowerCase() === "solo";
  const orgSlot = isSolo ? "SOLO" : organizer;

  const head: string[] = [];
  if (state) head.push(state.toUpperCase());
  if (brand) head.push(`[${brand}]`);
  if (orgSlot) head.push(orgSlot);
  const left = head.join(" ");
  if (!venue) return left;
  if (!left) return `@ ${venue}`;
  return `${left} @ ${venue}`;
}
