/* Does an invoice line and the delivery / receipt line it names describe the
 * SAME PRODUCT?
 *
 * WHY THIS EXISTS. `sales_invoice_items.do_item_id` and
 * `purchase_invoice_items.grn_item_id` are both taken from the CLIENT on the
 * create and add-line paths. Those paths check company, parent status and a
 * quantity cap — and never the item. `docs/bugs/0672` lists them as site 15 of
 * the key-without-identity sweep, and `probe-link-identity.mjs` (runs
 * 34137796488 and 34139187692, 2026-09-07 23:22 and 23:37 local) then measured
 * what that permits, in production:
 *
 *     sales_invoice_items.do_item_id      2 wrong of 182 linked of 182
 *     purchase_invoice_items.grn_item_id  3 wrong of 198 linked of 198
 *
 * Every one is FILLED and none DANGLES — the foreign key resolves to a real row
 * — so no constraint fires and the document-link matrix reports both chains
 * clean. `docs/bugs/0676` carries the trace.
 *
 * WHY EQUALITY IS THE RIGHT ASSERTION, and this is measured rather than
 * assumed: every from-DO and from-GRN converter copies `item_code` off the
 * source row, so a correctly-raised line agrees with its parent BY
 * CONSTRUCTION — and the probe's own denominators say so, 180 of 182 and 195 of
 * 198 already agree. The rule is not new; it was simply never applied here.
 *
 * WHAT A WRONG LINK COSTS, and it is not the invoice's face value. The line
 * carries its own quantity and price, so the amount billed does not move. The
 * link decides what happens downstream:
 *   - `do_item_id` is the `invoiced` term in
 *     remaining = delivered - invoiced - returned (lib/do-line-remaining.ts),
 *     the cap every DO -> Sales Invoice write path is checked against
 *     (migration 0303's header: "the column a MONEY CEILING rests on"). A wrong
 *     link spends one delivery line's allowance on a different product's line.
 *   - `grn_item_id` is how a supplier invoice's money reaches the LOT it paid
 *     for: lib/recost.ts aggregates PI lines BY `grn_item_id` and re-costs that
 *     receipt, and `grn_items.invoiced_qty` is a stored counter on the same key.
 *
 * THE GUARD TAKES ITS OWN READ, deliberately. `checkSiReopenOverRemaining` in
 * lib/do-line-remaining.ts already paid for the alternative and wrote the lesson
 * down: "a guard whose inputs are assembled somewhere else is a guard that can
 * be starved" — a failed read upstream made a real ceiling indistinguishable
 * from an invoice with no linked lines. So the read is part of the guard, it is
 * company-scoped, and it FAILS CLOSED.
 *
 * The refusal shape mirrors `soLinkTargetRefusal` / `so-link-item-identity.ts`
 * on the purchase-order chain, so the three chains answer a client identically.
 */

/** Which chain is being asserted. Decides the table read and the wording. */
export type InvoiceSourceChain = 'DO' | 'GR';

const CHAIN = {
  DO: { table: 'delivery_order_items', noun: 'Delivery Order line', pickAction: 'Pick the matching delivery line' },
  GR: { table: 'grn_items', noun: 'Goods Receipt line', pickAction: 'Pick the matching receipt line' },
} as const;

export type InvoiceSourceLine = {
  /** `doItemId` or `grnItemId` — null / undefined means a direct line, which is
   *  legitimate (the owner's rule is that an invoice MAY carry standalone
   *  lines) and is not this guard's business. */
  sourceItemId: string | null | undefined;
  /** The EFFECTIVE item code being written. On an edit path that is the
   *  post-patch value, not the body's — a patch that omits `itemCode` keeps the
   *  stored one, and the stored one is what ends up next to the link. */
  itemCode: unknown;
};

export type InvoiceSourceMismatch = {
  error: 'source_link_material_mismatch';
  reason: string;
  sourceItemId: string;
  sourceItemCode: string | null;
  itemCode: string | null;
};

export type InvoiceSourceRow = { id: string; item_code: string | null };

/** Trim, upper-case, collapse inner whitespace — the way a person reads a code.
 *  Identical to `so-link-item-identity.ts` and to `normItemCode` in
 *  scripts/lib/ac-po-line.mjs. Anything looser hides a real mismatch; anything
 *  stricter reports formatting as a wrong product. */
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * PURE. The FIRST line whose source names a different product, or null when
 * every linked line agrees with the line it was raised from.
 *
 * A source id that resolved to NOTHING is refused rather than skipped. The
 * callers' own scope checks reject an unknown id before this runs, so reaching
 * here means the row is absent or out of company — and an unresolvable source
 * cannot be asserted equal to anything. Skipping it is how a guard reports
 * clean over a population it never saw.
 */
export function invoiceSourceItemMismatch(
  chain: InvoiceSourceChain,
  lines: InvoiceSourceLine[],
  sourceRows: InvoiceSourceRow[],
): InvoiceSourceMismatch | null {
  const byId = new Map(sourceRows.map((r) => [r.id, r]));
  for (const line of lines) {
    const sourceItemId = line.sourceItemId ?? null;
    if (!sourceItemId) continue;
    const src = byId.get(sourceItemId) ?? null;
    const srcCode = norm(src?.item_code);
    const lineCode = norm(line.itemCode);
    if (srcCode && srcCode === lineCode) continue;
    const shown = String(line.itemCode ?? '') || '(no item)';
    const srcShown = src ? (src.item_code ?? '(no item)') : '(the source line is not there)';
    return {
      error: 'source_link_material_mismatch',
      reason: `This line bills ${shown}, but the ${CHAIN[chain].noun} it is raised from is for ${srcShown}. ${CHAIN[chain].pickAction}, or leave the source blank.`,
      sourceItemId,
      sourceItemCode: src?.item_code ?? null,
      itemCode: (line.itemCode as string | null | undefined) ?? null,
    };
  }
  return null;
}

export type InvoiceSourceRefusal =
  | { status: 409; body: InvoiceSourceMismatch }
  | { status: 409; body: { error: 'company_unresolved'; reason: string; message: string } }
  | { status: 503; body: { error: 'source_identity_unavailable'; reason: string; message: string } };

/**
 * The guard, read included. Returns a refusal to hand straight to the route, or
 * null when there is nothing to refuse.
 *
 * `companyId` is REQUIRED and not optional. It decides which rows this guard is
 * allowed to compare against, and an optional scope is the shape CLAUDE.md
 * names: every caller that says nothing keeps the unscoped behaviour with no
 * compile error. It is `number | null` rather than `number` so an UNRESOLVED
 * company is a value a caller must pass deliberately — and null REFUSES, which
 * is the stricter direction, never a silently unscoped read.
 *
 * FAILS CLOSED. A read that errors is a 503, never a pass: this guard exists
 * because a silent success is exactly what the defect looks like.
 */
export async function checkInvoiceSourceItemIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  chain: InvoiceSourceChain,
  lines: InvoiceSourceLine[],
  companyId: number | null,
): Promise<InvoiceSourceRefusal | null> {
  const ids = [...new Set(lines.map((l) => l.sourceItemId).filter((x): x is string => !!x))];
  if (ids.length === 0) return null;
  /* An unresolved company cannot be compared against anything. Refuse rather
     than read every company's rows — the same answer scopeToCompany gives. */
  if (companyId == null) {
    return { status: 409, body: { error: 'company_unresolved', reason: 'no active company', message: 'No active company is selected, so this invoice line cannot be checked against the document it comes from.' } };
  }
  const { data, error } = await sb.from(CHAIN[chain].table)
    .select('id, item_code')
    .in('id', ids)
    .eq('company_id', companyId);
  if (error) {
    return {
      status: 503,
      body: {
        error: 'source_identity_unavailable',
        reason: `${CHAIN[chain].table}: ${error.message}`,
        message: `The ${CHAIN[chain].noun} this invoice line comes from could not be read, so it cannot be checked. Nothing was saved — try again.`,
      },
    };
  }
  const mismatch = invoiceSourceItemMismatch(chain, lines, (data ?? []) as InvoiceSourceRow[]);
  return mismatch ? { status: 409, body: mismatch } : null;
}
