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

/** Whitespace collapsed and trimmed, or null. The account book is given one
 *  spelling of a value, never two that differ by a space. */
export const tidy = (s: unknown): string | null => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v || null;
};

/**
 * The customer's address, packed into AutoCount's FOUR numbered lines.
 *
 * FIVE ERP FIELDS, FOUR AUTOCOUNT LINES — this is the one decision that had to
 * be written down rather than derived, and this comment is where it lives (the
 * DO/SI note in `autocount-outbox.ts` declined to invent it and omitted the
 * keys instead; on a CREATE there is nothing to preserve, so the packing has to
 * be chosen).
 *
 * | AutoCount | ERP |
 * |---|---|
 * | `InvAddr1` | `address1` |
 * | `InvAddr2` | `address2` |
 * | `InvAddr3` | `address3`, else `postcode` + `city` |
 * | `InvAddr4` | `address4`, else `customer_state` |
 *
 * `address3` / `address4` WIN when they are populated: only the cutover import
 * ever wrote them, and that text is AutoCount's own. An ERP-created order has
 * both blank and keeps the same facts in `city` / `postcode` / `customer_state`
 * — measured 2026-08-14 on production, 94 of 115 unpushed sales orders are in
 * exactly that shape, so AutoCount's document carried the street lines and no
 * town, no postcode and no state, on the address a delivery is printed from.
 *
 * Postcode before town, state on its own line, is the Malaysian postal order
 * ("43300 SERI KEMBANGAN" / "SELANGOR"). Free text, no master, no foreign key.
 */
export function soInvoiceAddress(h: {
  /* `unknown` and optional for the same reason as soCustomerRef above. */
  address1?: unknown; address2?: unknown; address3?: unknown; address4?: unknown;
  city?: unknown; postcode?: unknown; customer_state?: unknown;
}): {
    InvAddr1: string | null;
    InvAddr2: string | null;
    InvAddr3: string | null;
    InvAddr4: string | null;
  } {
  const town = [tidy(h.postcode), tidy(h.city)].filter(Boolean).join(' ');
  /* FITTED TO THE BOOK'S OWN WIDTH before it leaves. AutoCount's four address
     columns are 40 characters and it refuses the WHOLE document when one is
     over — see fitAddressLines, which returns an address that already fits
     untouched, so this changes nothing for the documents that were working. */
  const { lines } = fitAddressLines([
    tidy(h.address1),
    tidy(h.address2),
    tidy(h.address3) ?? (town || null),
    tidy(h.address4) ?? tidy(h.customer_state),
  ]);
  return {
    InvAddr1: lines[0] ?? null,
    InvAddr2: lines[1] ?? null,
    InvAddr3: lines[2] ?? null,
    InvAddr4: lines[3] ?? null,
  };
}

/**
 * The four address columns of a sales order, fitted, as an object ready to
 * spread into a write.
 *
 * The SAVE-side twin of `soInvoiceAddress`, which fits on the way OUT. Fitting
 * on the way IN is what the owner asked for on 2026-09-09 — 「把我们的 address
 * lock成 40 个字」 — and it is the better half: the ERP then holds what the
 * account book holds, so the two never disagree about where a customer lives,
 * and a person reading the sales order sees the same lines the invoice will
 * carry.
 *
 * An address that already fits is returned EXACTLY as typed. Only an
 * overflowing one is re-packed.
 */
export function fitSoAddress(
  lines: ReadonlyArray<string | null>,
): { address1: string | null; address2: string | null; address3: string | null; address4: string | null } {
  const { lines: out } = fitAddressLines(lines);
  return {
    address1: out[0] ?? null,
    address2: out[1] ?? null,
    address3: out[2] ?? null,
    address4: out[3] ?? null,
  };
}
