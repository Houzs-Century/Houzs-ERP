/**
 * THREE DECISIONS THE COMPARTMENT CORRECTION HAS TO GET RIGHT, KEPT PURE SO
 * THEY CAN BE TESTED WITHOUT A DATABASE.
 *
 * Each one was bought by a real document measured on prod (company 1) on
 * 2026-09-04, and each one is a way the previous shape of the script was
 * silently WRONG rather than loudly broken.
 *
 * ── 1. TWO IDENTICAL LINES ARE TWO SOFAS, NOT ONE ───────────────────────────
 * HC-SO-013384 holds two `8030-1S` lines with byte-identical Desc2, and so does
 * HC-SO-012025 (with its purchase order HC-PO-009024). They are two identical
 * sofas. The matcher correctly returns BOTH rows, and the pairing then dealt
 * them out as if they were two compartments of ONE build: row 1 became the
 * first piece, row 2 the second, the third was inserted — one sofa where the
 * customer ordered two, with no error and no refusal. `splitBuildCopies` below
 * is what stops that.
 *
 * ── 2. THE MONEY ASSERTION HAS TO MEASURE THE MONEY ─────────────────────────
 * The rule is right: the whole build's price rides the FIRST piece and every
 * other piece is 0, before and after. The check was reading only
 * `line_total_sen`, and on `scm.purchase_order_items` that column is 0 on ALL
 * 289 company-1 sofa lines while `unit_price_sen` carries the price. So on a PO
 * the check compared 0 against a recomputed `unit x qty` and REFUSED correct
 * work (HC-PO-009582 at 183200, HC-PO-009260 at 254000, HC-PO-009024 at 95000)
 * — while asserting nothing at all about the money, because 0 == 0 would have
 * passed for any price. This is the repo's "check that answers a different
 * question", and the fix is to assert BOTH columns and to RECOMPUTE NOTHING:
 * the lead piece keeps the lead row's own numbers verbatim, everything else
 * goes to 0.
 *
 * ── 3. A SEAT IS INCHES, AND `60cm` IS NOT ──────────────────────────────────
 * `variants.seatHeight` is a bare number of inches — measured on prod the live
 * values are 22, 24, 25, 26, 28, 30, 31, 32, 35, 38, 40 and null, with no unit
 * anywhere. HC-SO-003295's slip says `60cm`. Writing "60cm" makes a numeric
 * field non-numeric; writing "60" makes a 60-INCH seat out of a 60-centimetre
 * one. Neither is honest, so `seatHeightToWrite` writes nothing and says so.
 *
 * Zero dependencies — `node --test scripts/lib/*.test.mjs` runs the test on a
 * bare checkout.
 */

/** Upper-cased, trimmed — the form codes are compared in. */
export const K = (s) => String(s ?? "").trim().toUpperCase();

/** The compartment half of `8030-1A(LHF)`; "" for a code with no dash. */
export const compartmentOf = (code) => {
  const c = K(code);
  const d = c.indexOf("-");
  return d < 0 ? "" : c.slice(d + 1);
};

/**
 * Should this correction's `seat` be written into `variants.seatHeight`?
 *
 * @param {unknown} seat the correction's `seat`
 * @returns {{ write: boolean, value: string|null, why: string }}
 */
export function seatHeightToWrite(seat) {
  if (seat === null || seat === undefined || String(seat).trim() === "")
    return { write: false, value: null, why: "no seat on this correction" };
  const s = String(seat).trim();
  if (/^\d{1,3}(\.\d+)?$/.test(s)) return { write: true, value: s, why: "inches" };
  return {
    write: false,
    value: null,
    why: `seat "${s}" is not a number of inches — seatHeight holds bare inches, so it is left as it is rather than stored as ${s.replace(/[^\d.]/g, "") || "?"} inches`,
  };
}

/**
 * Split the rows the matcher selected for ONE correction into the sofas they
 * actually are.
 *
 * A row whose code is not one of the target pieces is a PLACEHOLDER waiting for
 * the build. One placeholder is one sofa. Two placeholders under one Desc2 are
 * two identical sofas, and each takes the whole build.
 *
 * It refuses rather than guesses in the one case it cannot read: several
 * placeholders sitting next to rows that are ALREADY correct pieces, where
 * nothing in the data says which sofa those correct pieces belong to.
 *
 * @param {any[]} rows the build's rows, in document order
 * @param {string[]} want the target piece codes, fully qualified and upper-cased
 * @param {(row:any)=>unknown} [codeOf]
 * @returns {{ ok: true, copies: any[][], how: string } | { ok: false, why: string }}
 */
export function splitBuildCopies(rows, want, codeOf = (r) => r.code) {
  const all = Array.isArray(rows) ? rows.slice() : [];
  const target = new Set(want.map(K));
  const placeholders = all.filter((r) => !target.has(K(codeOf(r))));
  const already = all.filter((r) => target.has(K(codeOf(r))));

  if (placeholders.length <= 1)
    return { ok: true, copies: [all], how: "one sofa on this build" };

  if (already.length)
    return {
      ok: false,
      why: `${placeholders.length} placeholder lines AND ${already.length} line(s) that are already target pieces — which sofa the correct pieces belong to is not written down anywhere, and picking one is not this script's call`,
    };

  return {
    ok: true,
    copies: placeholders.map((r) => [r]),
    how: `${placeholders.length} identical sofas on this build — each takes the whole build`,
  };
}

/** The two money columns of one row, as numbers. */
export const moneyOfRow = (r) => ({
  total: Number(r?.total ?? 0),
  charged: Number(r?.unit_price_sen ?? 0) * (Number(r?.qty ?? 1) || 1),
});

/** Both money columns summed over a set of rows. */
export function moneyOfRows(rows) {
  return (rows || []).reduce(
    (a, r) => {
      const m = moneyOfRow(r);
      return { total: a.total + m.total, charged: a.charged + m.charged };
    },
    { total: 0, charged: 0 },
  );
}

/**
 * Which row carries this sofa's price, and what every piece is worth after.
 *
 * NOTHING IS RECOMPUTED. The lead piece keeps the lead row's own
 * `unit_price_sen` and its own total column, verbatim; every other piece is 0
 * in both. That is the only assignment under which the document's money is
 * arithmetically identical before and after, whichever of the two columns the
 * table actually maintains.
 *
 * @param {any[]} copyRows the rows of ONE sofa
 * @returns {{ ok: true, lead: any, price: number, total: number, before: {total:number,charged:number} }
 *          | { ok: false, why: string }}
 */
export function planCopyMoney(copyRows) {
  const rows = copyRows || [];
  if (!rows.length) return { ok: false, why: "no rows" };
  const before = moneyOfRows(rows);
  const lead = rows.reduce((a, r) => {
    const m = moneyOfRow(r), n = moneyOfRow(a);
    if (m.total !== n.total) return m.total > n.total ? r : a;
    return m.charged > n.charged ? r : a;
  }, rows[0]);
  const m = moneyOfRow(lead);
  const after = { total: m.total, charged: m.charged };
  if (after.total !== before.total || after.charged !== before.charged)
    return {
      ok: false,
      why: `money would move — total ${before.total} -> ${after.total}, charged ${before.charged} -> ${after.charged}. More than one line of this sofa carries money, so "the price rides the first piece" is not true of it and this script must not make it true`,
    };
  return { ok: true, lead, price: Number(lead.unit_price_sen ?? 0), total: m.total, before };
}

/**
 * Pair a sofa's existing rows onto the target pieces, in place wherever the
 * code already matches, so a row id — and the purchase dedication hanging off
 * it — survives.
 *
 * @param {any[]} rows one sofa's rows
 * @param {string[]} want target piece codes, fully qualified and upper-cased
 * @param {(row:any)=>unknown} [codeOf]
 * @returns {{ pairs: {want:string,row:any|null}[], surplus: any[] }}
 */
export function pairRowsToPieces(rows, want, codeOf = (r) => r.code) {
  const pool = (rows || []).slice();
  const pairs = [];
  for (const w of want) {
    const i = pool.findIndex((r) => K(codeOf(r)) === K(w));
    pairs.push({ want: K(w), row: i >= 0 ? pool.splice(i, 1)[0] : null });
  }
  /* Reuse a leftover row rather than delete-and-insert: the id is what carries
     the dedication. */
  for (const p of pairs) if (!p.row && pool.length) p.row = pool.shift();
  return { pairs, surplus: pool };
}
