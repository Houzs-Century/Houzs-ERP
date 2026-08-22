// The purchase-consignment ledger writes get the idempotency backstop and stop
// discarding their own failures.
//
// 2026-08-21 full-flow audit, item A11: 0154 declared PC off-ledger and the
// code went on-ledger on 2026-06-05 — with no uq_inv_mov_* index behind
// PC_RECEIVE / PC_RETURN, a concurrent double-post (or a retry behind a Worker
// timeout) booked the consigned stock twice, and the post path's bare
// `catch { /* best-effort */ }` around a function that itself never throws
// discarded the only evidence.
//
// Structural pins: migration shape + the capture-not-discard contract.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(__dirname, '../src/db/migrations-pg/0321_pc_inventory_idempotency.sql'),
  'utf8',
);
const RCV = readFileSync(
  resolve(__dirname, '../src/scm/routes/purchase-consignment-receives.ts'),
  'utf8',
);

describe('mig 0321 — the PC backstop indexes', () => {
  it('creates both partial unique indexes in the 0279 v2 shape', () => {
    for (const idx of ['uq_inv_mov_pc_receive_source', 'uq_inv_mov_pc_return_source']) {
      const at = MIG.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx}`);
      expect(at, `${idx} missing`).toBeGreaterThan(-1);
      const stmt = MIG.slice(at, MIG.indexOf(';', at));
      expect(stmt).toContain('COALESCE(correction_seq, 0)');
      /* item_code, not product_code: 0307_item_code_unify renamed the column,
         and the original 0321 (written in 0279's vocabulary) failed on prod
         with `column "product_code" does not exist` — ledger 0513. This
         assertion pinned the stale name; it now pins the live one. */
      expect(stmt).toContain('source_doc_type, source_doc_id, item_code, variant_key');
    }
    expect(MIG).toContain("WHERE (source_doc_type = 'PC_RECEIVE'::text)");
    expect(MIG).toContain("WHERE (source_doc_type = 'PC_RETURN'::text)");
  });

  it('numbers historical duplicates BEFORE the index builds, and deletes nothing', () => {
    const stamp = MIG.indexOf('UPDATE scm.inventory_movements');
    const firstIndex = MIG.indexOf('CREATE UNIQUE INDEX');
    expect(stamp, 'duplicate-stamping UPDATE missing').toBeGreaterThan(-1);
    expect(stamp, 'stamping must precede the index build').toBeLessThan(firstIndex);
    expect(MIG).not.toMatch(/DELETE\s+FROM/i);
    // Idempotent re-run: only un-stamped rows are considered.
    expect(MIG).toContain('correction_seq IS NULL');
  });

  it('pins the search_path, per the 0267 deploy-block lesson', () => {
    expect(MIG).toContain('SET search_path = scm, public;');
  });
});

describe('purchase-consignment-receives — the resync result is captured, not discarded', () => {
  it('the post chokepoint returns movementErrors instead of a bare catch', () => {
    const seg = RCV.slice(
      RCV.indexOf('async function postPcReceiveAndRollup'),
      RCV.indexOf('async function resyncReceiveInventory'),
    );
    expect(seg).toContain('movementErrors = await resyncReceiveInventory');
    expect(seg).not.toContain('catch { /* best-effort */ }');
    expect(seg).toContain('movementErrors?: string[]');
  });

  it('the create, from-pcos, post, add-line and edit-line responses carry the field', () => {
    /* Six carrier sites (the rollup's own return + five responses); a site
       that stops spreading it goes silent again. */
    const spreads = RCV.split('? { movementErrors').length - 1;
    expect(spreads, 'a carrier site dropped movementErrors — re-count and re-pin').toBeGreaterThanOrEqual(6);
  });
});
