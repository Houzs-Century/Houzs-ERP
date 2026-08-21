// The bare-create Purchase Return gets the guards its siblings already had.
//
// 2026-08-21 full-flow audit, items B2/B3/B4/B5: POST /purchase-returns was
// the thinnest stock-moving path in the module —
//   B3  the over-return cap read discarded its error, so a read blip skipped
//       the cap AND the cross-company line guard in one silent stroke;
//   B5  neither the header grnId nor the caller-supplied grn_item ids were
//       checked against the source GRN's STATUS, so cancel-first-return-second
//       wrote a second OUT for goods whose reversing OUT already ran;
//   B4  no post-insert re-verification, so two concurrent creates against one
//       GRN line both passed the pre-check and drove stock negative — with
//       adjustGrnReturnedQty's clamp making the excess permanently invisible;
//   B2  pre-write refusals kept the idempotency claim, so a corrected resubmit
//       died on idempotency_key_reused until a full page reload.
//
// The handler needs a live DB; this pins the SOURCE. Each slice is bounded so
// a different handler cannot satisfy it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../src/scm/routes/purchase-returns.ts'),
  'utf8',
);

/* The bare-create handler: from its route registration to the from-grns
   handler's leading comment. */
function bareCreate(): string {
  const start = SRC.indexOf("purchaseReturns.post('/', async (c) => {");
  const end = SRC.indexOf('Batch-convert multiple POSTED GRNs', start);
  expect(start, 'bare-create route not found').toBeGreaterThan(-1);
  expect(end, 'from-grns comment anchor not found').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('POST /purchase-returns — fail-closed reads (B3, B15a)', () => {
  it('binds the cap read error and refuses instead of skipping the cap', () => {
    const seg = bareCreate();
    expect(seg).toContain('const { data: giRows, error: giErr }');
    expect(seg).toContain("error: 'cap_check_failed'");
  });

  it('binds the header source-GRN read error', () => {
    const seg = bareCreate();
    expect(seg).toContain('const { data: srcGrn, error: srcErr }');
    expect(seg).toContain("error: 'source_check_failed'");
  });

  it('refuses a supplied grn_item id the read did not answer — not a free line', () => {
    expect(bareCreate()).toContain("error: 'grn_item_not_found'");
  });
});

describe('POST /purchase-returns — the source must be a POSTED receipt (B5)', () => {
  it('gates the header grnId on POSTED', () => {
    const seg = bareCreate();
    const headerGate = seg.indexOf("src.status !== 'POSTED'");
    expect(headerGate, 'header POSTED gate missing').toBeGreaterThan(-1);
  });

  it('gates every caller-supplied line id on its parent GRN being POSTED', () => {
    expect(bareCreate()).toContain("(parentOf(g)?.status ?? null) !== 'POSTED'");
  });

  it('the add-line path carries the same gate', () => {
    const start = SRC.indexOf('export const addPurchaseReturnItemHandler');
    expect(start).toBeGreaterThan(-1);
    const seg = SRC.slice(start, SRC.indexOf('const row: Record<string, unknown>', start));
    expect(seg).toContain("!== 'POSTED'");
    expect(seg).toContain("error: 'grn_not_posted'");
  });
});

describe('POST /purchase-returns — post-insert over-return verification (B4)', () => {
  it('re-derives the live returned sum after the insert and before the movements', () => {
    const seg = bareCreate();
    const verify = seg.indexOf('over_return_recheck_failed');
    expect(verify, 'post-insert verifier missing').toBeGreaterThan(-1);
    const movements = seg.indexOf('writePurchaseReturnMovements(sb, h.id', verify);
    expect(movements, 'movement write must follow the verifier').toBeGreaterThan(verify);
  });

  it('the broken case rolls back the insert and releases the idempotency claim', () => {
    const seg = bareCreate();
    const rollback = seg.indexOf('const rollback = async () => {');
    expect(rollback).toBeGreaterThan(-1);
    const rollbackBody = seg.slice(rollback, seg.indexOf('writePurchaseReturnMovements', rollback));
    expect(rollbackBody).toContain('markIdempotencyNoWrite(c)');
  });
});

describe('POST /purchase-returns — refusals release the idempotency claim (B2)', () => {
  it('routes the early validation refusals through the marking helper', () => {
    const seg = bareCreate();
    expect(seg).toContain('const refuse = (status: number');
    // The helper itself marks; the early exits must use it, not bare c.json.
    expect(seg).toContain("return refuse(400, { error: 'supplier_required' })");
    expect(seg).toContain("return refuse(400, { error: 'items_required' })");
    expect(seg).toContain("return refuse(400, { error: 'no_returnable_qty'");
  });

  it('the from-grn and from-grns pre-write refusals mark too', () => {
    const fromGrns = SRC.slice(SRC.indexOf('Batch-convert multiple POSTED GRNs'));
    // Three representative gates, one per class: unreadable, absent, wrong status.
    for (const anchor of ["error: 'grns_not_found'", "error: 'not_all_posted'", "error: 'nothing_to_return'"]) {
      const at = fromGrns.indexOf(anchor);
      expect(at, `${anchor} not found`).toBeGreaterThan(-1);
      const before = fromGrns.slice(Math.max(0, at - 300), at);
      expect(before, `${anchor} does not mark no-write`).toContain('markIdempotencyNoWrite(c)');
    }
  });
});
