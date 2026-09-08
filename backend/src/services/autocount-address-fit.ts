// ----------------------------------------------------------------------------
// autocount-address-fit — the account book's address columns are 40 characters
// wide, and a document whose address is wider does not reach it at all.
//
// SPLIT OUT OF autocount-writeback.ts because that file is at its size ceiling
// and a ceiling only ever moves down (docs/repo-hygiene.md). It is also a seam
// worth having: this is one idea — how a string is made to fit a column the ERP
// does not own — and it is the first member of a class the rest of the
// write-back has not addressed yet (docs/bugs/0728).
// ----------------------------------------------------------------------------
/**
 * HOW WIDE THE ACCOUNT BOOK'S ADDRESS LINES ARE — measured, not assumed.
 *
 * `SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE
 * TABLE_NAME='SO' AND COLUMN_NAME LIKE 'InvAddr%'` against AED_HOUZS on
 * 2026-09-09: all four are **40**.
 *
 * A number in a comment is a fact with an expiry date (CLAUDE.md), so re-run
 * that on the host rather than trusting this line. It cannot be read from here:
 * the account book is SQL Server on the office machine.
 */
export const AC_ADDRESS_LINE_MAX = 40;
export const AC_ADDRESS_LINES = 4;

/**
 * FIT AN ADDRESS INTO THE FOUR LINES THE ACCOUNT BOOK HAS.
 *
 * AutoCount refuses the WHOLE document when one line is too long — HC-SO-2609-006,
 * 2026-09-09, in its own words:
 *
 *   Cannot set column 'InvAddr1'. The value violates the MaxLength limit of this
 *   column.
 *
 * so a customer whose street line runs past forty characters could not have a
 * sales order in the accounts at all.
 *
 * THREE RULES, and the first is the one that keeps this safe to ship:
 *
 * 1. **An address that already fits is returned untouched.** Re-flowing every
 *    address would rewrite the line breaks of every document on the next edit,
 *    for the sake of the few that overflow. Only an overflowing address is
 *    re-flowed.
 * 2. **Re-flow, do not cut.** The words are re-packed across the four lines at
 *    word boundaries, so the postal content survives in order — this is the
 *    address a delivery is printed from, and a truncated one sends goods to the
 *    wrong place. A single word longer than a line is hard-split, because
 *    nothing else can be done with it.
 * 3. **What does not fit is REPORTED, never silently dropped.** Four lines of
 *    forty is 160 characters; an address that overruns that is a data problem
 *    and the caller is told which words were lost.
 */
export function fitAddressLines(
  lines: ReadonlyArray<string | null>,
): { lines: (string | null)[]; dropped: string | null } {
  const kept = lines.map((l) => (l == null ? null : l));
  /* THE COMMON CASE FIRST, and it returns the input by identity of value: no
     address that already fits is ever re-flowed. */
  if (kept.every((l) => (l ?? '').length <= AC_ADDRESS_LINE_MAX)) {
    return { lines: kept, dropped: null };
  }

  /* Every word, in order, across the lines. The original breaks become spaces
     because the packing decides the new ones — which is the whole point. */
  const words: string[] = [];
  for (const l of kept) for (const w of (l ?? '').split(' ')) if (w) words.push(w);

  const out: string[] = [];
  let current = '';
  const flush = () => { if (current) { out.push(current); current = ''; } };
  for (let i = 0; i < words.length; i += 1) {
    let w = words[i] as string;
    /* A word wider than the line cannot be packed, only broken. Rare, and the
       alternative is dropping it. */
    while (w.length > AC_ADDRESS_LINE_MAX) {
      flush();
      if (out.length >= AC_ADDRESS_LINES) break;
      out.push(w.slice(0, AC_ADDRESS_LINE_MAX));
      w = w.slice(AC_ADDRESS_LINE_MAX);
    }
    if (out.length >= AC_ADDRESS_LINES && !current) {
      /* No room left: everything from here is the overflow. */
      return {
        lines: padLines(out),
        dropped: [w, ...words.slice(i + 1)].join(' ') || null,
      };
    }
    const next = current ? `${current} ${w}` : w;
    if (next.length <= AC_ADDRESS_LINE_MAX) { current = next; continue; }
    flush();
    if (out.length >= AC_ADDRESS_LINES) {
      return { lines: padLines(out), dropped: words.slice(i).join(' ') || null };
    }
    current = w;
  }
  flush();
  return { lines: padLines(out), dropped: null };
}

/** Four entries always, so the caller can map them onto the four columns and a
 *  line the address no longer needs is BLANKED rather than left as it was. */
function padLines(out: readonly string[]): (string | null)[] {
  const four: (string | null)[] = [];
  for (let i = 0; i < AC_ADDRESS_LINES; i += 1) four.push(out[i] ?? null);
  return four;
}
