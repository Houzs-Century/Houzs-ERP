/* How a project's CODE and NAME are derived from its identity fields.
 *
 * Both formats are contracts, not conveniences: mig 071 backfilled every
 * existing row to them, `backfill-project-codes.mjs` rewrites the legacy
 * `PRJ-YYYY-NNN` rows to them, and `seed-projects.mjs` has to land on the SAME
 * string or a re-seed creates a second project for an event that already
 * exists. They moved out of `services/projects.ts` (over its size ceiling) so
 * there is one obvious place to read them from, and so they could be tested —
 * neither had a test, and one of the two rules below had already been
 * hand-copied WRONG into the seed script.
 *
 * The mirror for `.mjs` scripts, which cannot import TypeScript, is
 * `backend/scripts/lib/project-naming.mjs`, pinned by
 * `backend/tests/projectNamingMirror.test.ts`. Same arrangement as
 * `variant-axes.mjs`, and for the same reason.
 */

function slugSegment(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `YYYY-MM-{ORGANIZER}-{STATE}-{VENUE}-{BRAND}` — the code describes the event.
 *
 * State, venue and brand are REQUIRED and this throws without them; the caller
 * (`createProject`) relies on that rather than minting a code with a hole in it.
 * Organizer is the one optional slot and defaults to the literal `SOLO`.
 *
 * On collision — two projects with identical inputs in the same month —
 * `uniqueProjectCode` appends `-2`, `-3`, …
 */
export function deriveProjectCode(input: {
  year: number;
  month: number;
  organizer?: string | null;
  state?: string | null;
  venue?: string | null;
  brand?: string | null;
  /** Optional event-type slug. When "solo", the organizer slot is
   *  forced to the literal "SOLO" regardless of whether an organizer
   *  was picked — a solo event is by definition not organised by
   *  anyone. Mirrors `composeDefaultProjectName` on the frontend. */
  event_type_slug?: string | null;
}): string {
  const state = slugSegment(input.state);
  const venue = slugSegment(input.venue);
  const brand = slugSegment(input.brand);
  if (!state) throw new Error("state is required to generate a project code");
  if (!venue) throw new Error("venue is required to generate a project code");
  if (!brand) throw new Error("brand is required to generate a project code");
  const isSolo = (input.event_type_slug || "").toLowerCase() === "solo";
  const organizer = isSolo ? "SOLO" : (slugSegment(input.organizer) || "SOLO");
  const yyyy = String(input.year);
  const mm = String(input.month).padStart(2, "0");
  return `${yyyy}-${mm}-${organizer}-${state}-${venue}-${brand}`;
}

/**
 * `{state} [{brand}] {organizer | SOLO} @ {venue}`
 *
 *   JOHOR [AKEMI] KAI HAO (KL CHEN) @ PARADIGM MALL
 *   SABAH [AKEMI] SOLO @ SURIA SABAH        (organizer NULL -> "SOLO")
 *
 * Unlike the code, every slot has a fallback (an em dash) — a name is a label
 * and must always render.
 *
 * A picked organizer ALWAYS wins the slot — solo events included. This used to
 * force "SOLO" for solo events even when an organizer was chosen, which is how
 * nine projects ended up saying SOLO on the calendar while their Excel
 * organizer column said MALL MGMT (owner 2026-08-17, IOI Mall Damansara:
 * "supposed for ioi mall damansara mall mgt why got solo"). "SOLO" is only the
 * fallback for an empty organizer; the CODE keeps its SOLO segment (it is the
 * immutable identity, and the owner reads it as the event type there).
 */
export function deriveProjectName(input: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  /** Event-type slug; accepted for call-site symmetry with
   *  deriveProjectCode. The name no longer branches on it. */
  event_type_slug?: string | null;
}): string {
  const state = (input.state || "").trim() || "—";
  const brand = (input.brand || "").trim() || "—";
  const venue = (input.venue || "").trim() || "—";
  const organizer = (input.organizer || "").trim() || "SOLO";
  return `${state} [${brand}] ${organizer} @ ${venue}`;
}
