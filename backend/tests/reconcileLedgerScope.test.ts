// Company scoping on the read-only /reconcile ledger sweep (reconcileLedger).
//
// The operator-facing /reconcile report is per-company: reconcileLedger(sb,
// companyId) must filter EVERY document-header read to that company, or it
// surfaces the OTHER company's document numbers. Eight of its nine header reads
// wrapped the query in withCo(...); the ninth -- purchase_consignment_returns
// (the PC_RETURN flow) -- did not, so company A's report listed company B's
// PC-Return numbers (the movements index it checks against IS company-scoped,
// so B's unscoped return finds no A-movement and is emitted as a phantom
// "posted doc, zero movement" issue).
//
// This pins the fix in BOTH directions -- A's report never lists B's PC-Return
// docs and vice versa -- while the null-company System-Health mode still spans
// all companies (unchanged two-mode contract). reconcileLedger consumes a raw
// scm supabase client directly, so this drives it with a trimmed thenable
// PostgREST builder (same shape as companyScopeHardening.test.ts) -- no D1 or
// route harness needed.
import { describe, expect, test } from 'vitest';
import { reconcileLedger } from '../src/scm/lib/reconcile-ledger';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

// Minimal thenable PostgREST builder -- only the methods reconcileLedger calls
// (select / eq / neq / in / range) plus a `then` resolving the filtered rows.
// eq drives the company predicate under test; range is a no-op because the
// fixtures sit far below paginateAll's 1000-row page, so page 0 returns the
// whole (short) set and pagination stops.
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  range() { return this; }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    const data = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}

const fakeSb = (tables: Record<string, Row[]>) => ({
  from: (t: string) => new FakeQuery(tables[t] ?? []),
});

// Two PC-Returns, one per company, NEITHER with a matching PC_RETURN movement,
// so each is a legitimate "posted doc, zero movement" issue IN ITS OWN
// company's report -- the exact row the leak surfaced cross-company. The empty
// ledger makes the company predicate the only thing deciding what A vs B sees.
const fixture = (): Record<string, Row[]> => ({
  purchase_consignment_returns: [
    { id: 'pcr-a', return_number: 'PCR-A-1', company_id: CO_A, status: 'POSTED' },
    { id: 'pcr-b', return_number: 'PCR-B-1', company_id: CO_B, status: 'POSTED' },
  ],
  inventory_movements: [],
});

const pcReturnDocNos = (r: { issues: Array<{ docType: string; docNo: string }> }) =>
  r.issues.filter((i) => i.docType === 'PC Return').map((i) => i.docNo);

describe('reconcileLedger -- PC-Return read is company-scoped (both directions)', () => {
  test("company A's report lists A's PC-Return, never B's", async () => {
    const r = await reconcileLedger(fakeSb(fixture()), CO_A);
    expect(pcReturnDocNos(r)).toContain('PCR-A-1');
    expect(pcReturnDocNos(r)).not.toContain('PCR-B-1');
  });

  test("company B's report lists B's PC-Return, never A's", async () => {
    const r = await reconcileLedger(fakeSb(fixture()), CO_B);
    expect(pcReturnDocNos(r)).toContain('PCR-B-1');
    expect(pcReturnDocNos(r)).not.toContain('PCR-A-1');
  });

  // The other mode of the same function (System Health's cross-company
  // integrity count) passes no companyId and must still span all companies --
  // proving the fix scopes per-company without breaking the unscoped sweep.
  test('null-company (System Health) mode still spans all companies', async () => {
    const r = await reconcileLedger(fakeSb(fixture()), null);
    expect(pcReturnDocNos(r)).toContain('PCR-A-1');
    expect(pcReturnDocNos(r)).toContain('PCR-B-1');
  });
});
