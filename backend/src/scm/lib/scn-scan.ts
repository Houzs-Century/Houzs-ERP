// ----------------------------------------------------------------------------
// scn-scan.ts — what a scanned supplier credit note becomes (owner 2026-10-01:
// supplier 给我 cn，我要做 ocr for cn；这个 cn 可能会 link 去相对应的 supplier
// invoice). Pure: routes/credit-note-scan.ts reads the paper and the books,
// this decides the accounts, the amounts and the invoice each line credits.
// Nothing is saved until Finance saves the note.
// ----------------------------------------------------------------------------

/** The owner's accounts for a supplier credit note (2026-10-01): 「sponsorship -
    591-0000 (Booth Rental Sponsor)」「sales rebate - 591-0000」「Discount Received
    - 610-0001 (display cn)」. Matched on the line's words first, then on the
    note's remark (a display discount names its reason in the remark, its lines
    name the goods). No match leaves the line to the kind's default (PURCHASES
    RETURN) — Finance picks before saving. */
export const SCN_ACCOUNT_RULES: ReadonlyArray<{ test: RegExp; code: string; label: string }> = [
  { test: /\brebate/i, code: '591-0000', label: 'sales rebate' },
  { test: /\bsponsor/i, code: '591-0000', label: 'sponsorship' },
  { test: /\bdiscount/i, code: '610-0001', label: 'discount received' },
];

export function scnAccountFor(...texts: Array<string | null | undefined>): { code: string; label: string } | null {
  for (const t of texts) {
    if (!t) continue;
    const rule = SCN_ACCOUNT_RULES.find((r) => r.test.test(t));
    if (rule) return { code: rule.code, label: rule.label };
  }
  return null;
}

/** Spread the note's total over its lines. Houzs books a purchase WITH its SST
    (the purchase invoice carries the tax-inclusive price), so the credit comes
    off the same way: each line grows in proportion and the last takes the
    rounding, so the lines add up to the printed total. An unreadable total, or
    lines that add up to nothing, leave the lines as printed. */
export function spreadToTotal(amounts: number[], totalSen: number | null): number[] {
  const sum = amounts.reduce((s, a) => s + a, 0);
  if (totalSen == null || totalSen <= 0 || sum <= 0 || sum === totalSen) return amounts.slice();
  const out = amounts.map((a) => Math.round((a * totalSen) / sum));
  out[out.length - 1]! += totalSen - out.reduce((s, a) => s + a, 0);
  return out;
}

/** A description's words, folded to A–Z / 0–9, three characters or more. */
const words = (s: string): Set<string> =>
  new Set(s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3));

/** How well a credit-note line names a document's items: the most words any one
    item shares with the line. */
export function itemScore(lineText: string, itemTexts: string[]): number {
  const mine = words(lineText);
  let best = 0;
  for (const t of itemTexts) {
    let n = 0;
    for (const w of words(t)) if (mine.has(w)) n += 1;
    if (n > best) best = n;
  }
  return best;
}

export type PurchaseDoc = {
  kind: 'PI' | 'API';
  id: string;
  number: string;
  /** The supplier's invoice number the document was keyed with. */
  invoiceRef: string | null;
  invoiceDate: string | null;
  totalSen: number;
  paidSen: number;
  status: string;
  /** Its items' words (code, name, description) — what a line is matched on. */
  itemTexts: string[];
};

/** The document each line credits, and the one the whole note credits when the
    lines agree. A line naming an invoice looks among that invoice's documents;
    a line naming none looks among the note's. One candidate is the answer; among
    several (one supplier invoice keyed as three purchase invoices), the one whose
    items share the most words with the line, when it is the only best. */
export function pickCreditedDocs(
  lines: Array<{ text: string; invoiceNo: string | null }>,
  docs: PurchaseDoc[],
  noteInvoiceNos: string[],
): { perLine: Array<string | null>; suggested: PurchaseDoc | null } {
  const norm = (s: string | null) => (s ?? '').trim().toUpperCase();
  const forNos = (nos: string[]) => docs.filter((d) => nos.map(norm).includes(norm(d.invoiceRef)));
  const perLine = lines.map((l) => {
    const pool = forNos(l.invoiceNo ? [l.invoiceNo] : noteInvoiceNos);
    if (pool.length === 1) return pool[0]!.id;
    if (pool.length === 0) return null;
    const scored = pool.map((d) => ({ d, s: itemScore(l.text, d.itemTexts) })).sort((a, b) => b.s - a.s);
    return scored[0]!.s > 0 && scored[0]!.s > (scored[1]?.s ?? -1) ? scored[0]!.d.id : null;
  });
  const picked = [...new Set(perLine.filter((x): x is string => x != null))];
  const all = forNos(noteInvoiceNos);
  const suggestedId = picked.length === 1 && perLine.every((x) => x === picked[0]) ? picked[0]!
    : picked.length === 0 && all.length === 1 ? all[0]!.id
    : null;
  return { perLine, suggested: suggestedId ? docs.find((d) => d.id === suggestedId) ?? null : null };
}
