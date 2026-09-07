// THE CALL SITES of the invoice-chain identity guard, pinned.
//
// docs/bugs/0672's two structural observations are the reason this file exists
// and not just the behavioural test beside it:
//
//   "The rule is written correctly four or five times over and applied at N-1
//    of its N call sites." — soLinkTargetRefusal guards the add-line, the
//    patch-line and both allocation paths in mfg-purchase-orders.ts, and not
//    the create. planSoPoDedications guards sync-ac-delta's `links` lane and
//    not `dedi`, thirty lines down the same file.
//
//   "Every existing unlinked-line guard is scoped to `link IS NULL`." Four
//    EDIT paths let `item_code` be rewritten UNDER a live link, so a line can
//    drift out of identity with its parent after the fact. Two of those four
//    are the invoice paths pinned below.
//
// A call-site population is precisely what a unit test cannot see — that is
// docs/bugs/0099's lesson, and the instrument
// scripts/check-optional-decision-params.mjs already uses this shape here.
//
// EVERY assertion in this file FAILED before the guard was wired (6 failed of
// 6, on the tree carrying only the module and its behavioural test); the red
// run is quoted in docs/bugs/0677. If a refactor moves the code, do NOT delete
// an assertion — re-anchor it, or replace it with a behavioural test that
// proves the same refusal.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const read = (p) => readFileSync(join(BACKEND, p), 'utf8');

/** The text between two anchors, so an assertion is scoped to ONE call site. */
function between(src, startAnchor, endAnchor, label) {
  const a = src.indexOf(startAnchor);
  expect(a, `${label}: start anchor not found — re-anchor this test, do not delete it`).toBeGreaterThan(-1);
  const b = src.indexOf(endAnchor, a);
  expect(b, `${label}: end anchor not found — re-anchor this test, do not delete it`).toBeGreaterThan(a);
  return src.slice(a, b + endAnchor.length);
}

const GUARD = /checkInvoiceSourceItemIdentity\s*\(/;

describe('sales-invoices.ts — every path that writes do_item_id from a client body', () => {
  const src = read('src/scm/routes/sales-invoices.ts');

  it('imports the rule rather than restating it', () => {
    expect(src).toMatch(/from\s+'\.\.\/lib\/invoice-source-item-identity'/);
  });

  /* POST / — the bare create. Its lines carry a client-supplied doItemId and it
     already checks company, migrated-source, the shadow rule and the invoiced
     ceiling. It never compared the item. */
  it('POST / asserts identity before it inserts the lines', () => {
    const site = between(src, 'const over = await checkSiOverRemaining(sb, items);', 'const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo));', 'SI POST /');
    expect(site).toMatch(GUARD);
  });

  /* POST /:id/items — the add-line. Same client-supplied doItemId, same gap. */
  it('POST /:id/items asserts identity before it inserts the line', () => {
    const site = between(src, 'const over = await checkSiOverRemaining(sb, [it]);', 'const row = buildItemRow(id, it, nextLineNo);', 'SI add-line');
    expect(site).toMatch(GUARD);
  });

  /* PATCH /:id/items/:itemId — the EDIT door. unlinkedEditRefusal covers the
     case where the STORED link is null; a line that already carries a
     do_item_id could have its item_code rewritten to anything, which is how a
     correct link becomes a wrong one after the fact. The check must run on the
     EFFECTIVE post-patch code, not the body's. */
  it('PATCH /:id/items/:itemId asserts the POST-PATCH code still matches the stored link', () => {
    const site = between(src, "const repoint = await unlinkedEditRefusal(sb, 'sales-invoice', {", "sb.from('sales_invoice_items').update(updates)", 'SI patch-line');
    expect(site).toMatch(GUARD);
    expect(site, 'the guard must read the effective code, not it.itemCode alone').toMatch(/updates\[?'?item_code'?\]?|updates\.item_code/);
  });
});

describe('purchase-invoices.ts — every path that writes grn_item_id from a client body', () => {
  const src = read('src/scm/routes/purchase-invoices.ts');

  it('imports the rule rather than restating it', () => {
    expect(src).toMatch(/from\s+'\.\.\/lib\/invoice-source-item-identity'/);
  });

  /* POST / — the create. It already resolves the GRN rows for the qty cap and
     the cross-company refusal, and looked at every column except item_code. */
  it('POST / asserts identity before it builds the line rows', () => {
    const site = between(src, "return refuseWithoutWriting(c, { error: 'qty_exceeds_remaining', lines: over }, 409);", 'const itemRows = items.map((it) => {', 'PI POST /');
    expect(site).toMatch(GUARD);
  });

  /* POST /:id/items — the add-line. */
  it('POST /:id/items asserts identity before it inserts the line', () => {
    const site = between(src, "capColumn: 'qty_accepted', drawnColumns: ['invoiced_qty', 'returned_qty'],", 'const row: Record<string, unknown> = {', 'PI add-line');
    expect(site).toMatch(GUARD);
  });

  /* PATCH /:id/items/:itemId — the EDIT door. The file already calls the
     unlinked case "THE THIRD DOOR, and it was wide open" and closes it for
     `!grnItemId`. The LINKED case was the fourth door. */
  it('PATCH /:id/items/:itemId asserts the POST-PATCH code still matches the stored link', () => {
    const site = between(src, 'if (!grnItemId && it.itemCode !== undefined) {', "sb.from('purchase_invoice_items').update(updates)", 'PI patch-line');
    expect(site).toMatch(GUARD);
    expect(site, 'the guard must read the effective code, not it.itemCode alone').toMatch(/updates\[?'?item_code'?\]?|updates\.item_code/);
  });
});
