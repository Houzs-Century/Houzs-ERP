/* Plain-JS mirror of src/services/project-naming.ts, for the .mjs seed and
   backfill scripts, which cannot import TypeScript.
   PINNED by backend/tests/projectNamingMirror.test.ts — same arrangement as
   variant-axes.mjs, and for the same reason: seed-projects.mjs hand-copied the
   NAME format and left out the solo rule, so a solo event with a named
   organizer got one name from the app and a different one from the seed, while
   the script's own comment required them to converge. */

function slugSegment(s) {
  return (s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveProjectCode(input) {
  const state = slugSegment(input.state);
  const venue = slugSegment(input.venue);
  const brand = slugSegment(input.brand);
  if (!state) throw new Error('state is required to generate a project code');
  if (!venue) throw new Error('venue is required to generate a project code');
  if (!brand) throw new Error('brand is required to generate a project code');
  const isSolo = (input.event_type_slug || '').toLowerCase() === 'solo';
  const organizer = isSolo ? 'SOLO' : (slugSegment(input.organizer) || 'SOLO');
  const yyyy = String(input.year);
  const mm = String(input.month).padStart(2, '0');
  return `${yyyy}-${mm}-${organizer}-${state}-${venue}-${brand}`;
}

export function deriveProjectName(input) {
  // A picked organizer always wins the slot — solo events included (owner
  // 2026-08-17, IOI Mall Damansara). "SOLO" is only the empty fallback.
  // Mirrors services/project-naming.ts; projectNamingMirror.test.ts enforces.
  const state = (input.state || '').trim() || '—';
  const brand = (input.brand || '').trim() || '—';
  const venue = (input.venue || '').trim() || '—';
  const organizer = (input.organizer || '').trim() || 'SOLO';
  return `${state} [${brand}] ${organizer} @ ${venue}`;
}
