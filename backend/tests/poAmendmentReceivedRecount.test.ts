// A PO amendment that moves quantities must re-derive the received status.
//
// `purchase_orders.status` (SUBMITTED / PARTIALLY_RECEIVED / RECEIVED) is a
// CACHE derived from line qty vs received_qty by grns.ts recomputePoReceived.
// The amendment apply (applyPoAmendment / reviseBoundPo) rewrites line
// quantities and historically re-derived nothing — so a fully-received PO
// amended UPWARD stayed RECEIVED, and since the whole GRN surface gates on
// isReceivablePo, the added quantity could not be received through any
// path (docs/bugs/ ledger, 2026-08-21 audit item B10).
//
// Structural: the approve handler needs a live DB, so this pins the SOURCE —
// after the apply try/catch and before the status flip, the handler recounts
// the PO's own line ids. Anchors are unique strings on both ends.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../src/scm/routes/po-amendments.ts'),
  'utf8',
);

/* From the apply-failure return to the terminal-status UPDATE — the stretch
   both apply branches (follow-up reviseBoundPo and manual applyPoAmendment)
   fall through on success. */
function betweenApplyAndFlip(): string {
  const start = SRC.indexOf("'Failed to apply the Purchase Order revision.'");
  const end = SRC.indexOf("select('id, po_id, po_number, amendment_no, status, version')", start);
  expect(start, 'apply-failure anchor not found — did the approve handler move?').toBeGreaterThan(-1);
  expect(end, 'status-flip anchor not found after the apply').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('po-amendment approve — received status re-derived after the apply', () => {
  it('recounts the PO between the apply and the status flip', () => {
    const seg = betweenApplyAndFlip();
    expect(seg).toContain('recomputePoReceived(');
    expect(seg).toContain("from('purchase_order_items')");
    expect(seg).toContain("eq('purchase_order_id', amendment.po_id)");
  });

  it('binds the line-read error and degrades to a warning, never a rollback', () => {
    const seg = betweenApplyAndFlip();
    expect(seg).toContain('error: plErr');
    expect(seg).toContain('appliedWarnings');
  });

  it('imports the recount from its one home in grns.ts', () => {
    expect(SRC).toContain("import { recomputePoReceived } from './grns';");
  });
});
