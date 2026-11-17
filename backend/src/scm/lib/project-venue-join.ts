// ---------------------------------------------------------------------------
// project-venue-join.ts — a PMS project's venue row, for its Postcode / City.
//
// A project names its venue by TEXT (public.projects.venue), picked from the
// venue master (public.project_venues) in the project form — there is no
// venue_id column. The venue master is where Postcode / City / State live
// (migs 0178 / 0182), so a project's SETUP / DISMANTLE job reads them through
// this join: same company, case- and space-insensitive name, active row first,
// lowest id on a tie — exactly ONE row, so the join can never multiply a
// project into two board rows.
//
// One fragment, used by the Delivery Planning board's project union AND the DP
// order snapshot (routes/dp-orders.ts), so the two cannot disagree on which
// venue a project means. Plain SQL that runs on Postgres and on the D1 test
// mirror alike (no LATERAL, no btrim).
//
// Usage: `FROM projects p ${PROJECT_VENUE_JOIN}` and select
// ${PROJECT_VENUE_COLS} — the alias `p` is required.
// ---------------------------------------------------------------------------

export const PROJECT_VENUE_JOIN =
  `LEFT JOIN project_venues pv ON pv.id = (
      SELECT v.id FROM project_venues v
       WHERE v.company_id = p.company_id
         AND lower(trim(v.name)) = lower(trim(p.venue))
       ORDER BY v.active DESC, v.id
       LIMIT 1)`;

export const PROJECT_VENUE_COLS =
  'pv.postcode AS venue_postcode, pv.city AS venue_city, pv.state AS venue_state';

/** The board address of a project leg: the venue line, then the venue's City and
 *  Postcode the way a DP job's address carries them — each added only when the
 *  line does not already say it, so "Sunway Pyramid, 47500 Subang Jaya" is not
 *  shown with its postcode twice. PURE. */
export function projectBoardAddress(
  line: string | null,
  city: string | null,
  postcode: string | null,
): string | null {
  const base = (line ?? '').trim();
  const has = (part: string) => base.toLowerCase().includes(part.toLowerCase());
  const extra = [city, postcode]
    .map((v) => (v ?? '').trim())
    .filter((v) => v !== '' && !has(v));
  return [base, ...extra].filter((v) => v !== '').join(', ') || null;
}
