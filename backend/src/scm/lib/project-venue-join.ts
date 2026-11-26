
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
