// ---------------------------------------------------------------------------
// dp-no.ts — the DP Order number, DP-YYMMDD-<plateLetters><NN>.
//
// Owner spec 2026-07-18: "DP 应该根据年月日、罗里编号以及张单" — example
// DP-260718-WPX01 = 2026-07-18 · lorry plate WPX(4471) · the 01-th DP for THAT
// lorry on THAT day. So the number needs the LORRY (for its plate letters), which
// is why it is minted at SCHEDULE (assign lorry+date), not at create — exactly the
// owner's "schedule then DP number".
//
// The sequence resets per (date, lorry): DP-260718-WPX01, WPX02, … Same max(N)+1
// discipline as lib/doc-no.ts (NEVER count+1 — the 2026-06-12 POS outage), so a
// deleted DP never collapses the sequence onto a live one.
//
// Pure: no DB, no Date.now() (the date is the trip's date, passed in, so there is
// no timezone question and no clock dependency).
// ---------------------------------------------------------------------------

/**
 * The alphabetic part of a lorry plate, uppercased. "WPX 4471" → "WPX".
 * Falls back to the first letters anywhere, then "XX", so a DP number always has
 * a letter block even for an oddly-formatted plate.
 */
export function plateLetters(plate: string | null | undefined): string {
  const s = String(plate ?? '').trim().toUpperCase();
  const lead = s.match(/^[A-Z]+/);
  if (lead) return lead[0];
  const any = s.match(/[A-Z]+/);
  return any ? any[0] : 'XX';
}

/**
 * YYMMDD from an ISO date string ('YYYY-MM-DD', the trip_date DATE column).
 * Pure string slice — NOT `new Date()` — so a Malaysian trip date can never shift
 * a day across a UTC boundary (the disease BUG-HISTORY keeps recording).
 */
export function dpDatePart(isoDate: string | null | undefined): string {
  const m = String(isoDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1].slice(2) + m[2] + m[3] : '000000';
}

/** The DP number prefix (everything before the running NN): `DP-YYMMDD-LETTERS`. */
export function dpNoPrefix(isoDate: string, plate: string): string {
  return `DP-${dpDatePart(isoDate)}-${plateLetters(plate)}`;
}

/**
 * The next sequence for a prefix = max(existing suffix) + 1. Reads only DP
 * numbers that share the exact prefix (same date + same plate letters), so two
 * lorries on the same day keep independent runs. max+1, never count+1.
 */
export function nextDpSeq(existing: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const dp of existing) {
    if (typeof dp !== 'string' || !dp.startsWith(prefix)) continue;
    const n = parseInt(dp.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Assemble the full number: prefix + zero-padded 2-digit sequence. */
export function formatDpNo(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(2, '0')}`;
}

/** The whole mint in one call, from the trip's date + plate and the DP numbers
 *  already minted (for that day+plate — a caller may pass all and let the prefix
 *  filter). */
export function mintDpNo(isoDate: string, plate: string, existing: Iterable<string>): string {
  const prefix = dpNoPrefix(isoDate, plate);
  return formatDpNo(prefix, nextDpSeq(existing, prefix));
}
