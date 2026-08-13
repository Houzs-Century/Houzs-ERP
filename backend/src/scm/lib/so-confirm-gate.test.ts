import { describe, expect, it } from 'vitest';
import { collectSoConfirmProblems, soConfirmProblemsForDoc } from './so-confirm-gate';

/* ═══════════════════════════════════════════════════════════════════════════
   The confirm gate (owner rulings 2026-08-08): a Sales Order may only become
   CONFIRMED with a salesperson, a venue, and every line a REAL catalog SKU.

   It does NOT ask whether the lines are spec-complete. That is the PROCEED
   rule — owner 2026-08-13, "只要是没有 proceed 这一张订单，其实都不一定是需要
   填写的，除非它是 proceed 了" — and it lives with the other proceed gates in
   shared/so-save-problems.ts, fired by a Processing Date. The tests below pin
   that boundary in BOTH directions, because a variant check briefly lived here
   too (2026-08-08) and made a real order for a real customer unbookable before
   the customer had chosen a seat height.
   ═══════════════════════════════════════════════════════════════════════════ */

const GOOD = {
  salespersonId: 'staff-1',
  agent: null,
  venue: 'PJ Showroom',
  venueId: null,
  lines: [
    {
      itemCode: 'Y103-(Q)',
      group: 'bedframe',
      // spec facts are the PROCEED gate's business, not this gate's
    },
  ],
};

const codes = (problems: Array<{ code: string }>) => problems.map((p) => p.code);

describe('collectSoConfirmProblems', () => {
  it('a complete order confirms', () => {
    expect(collectSoConfirmProblems(GOOD)).toEqual([]);
  });

  it('no salesperson_id and no agent refuses; either one alone passes', () => {
    expect(codes(collectSoConfirmProblems({ ...GOOD, salespersonId: null, agent: '  ' })))
      .toContain('salesperson_required');
    expect(codes(collectSoConfirmProblems({ ...GOOD, salespersonId: null, agent: 'Lim' })))
      .toEqual([]);
    expect(codes(collectSoConfirmProblems({ ...GOOD, agent: null })))
      .toEqual([]);
  });

  it('no venue text and no venue_id refuses; either one alone passes', () => {
    expect(codes(collectSoConfirmProblems({ ...GOOD, venue: '' })))
      .toContain('venue_required');
    expect(codes(collectSoConfirmProblems({ ...GOOD, venue: null, venueId: 'v-1' })))
      .toEqual([]);
  });

  it('a product-less line (the scan placeholder) blocks confirm, naming the line', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [...GOOD.lines, { itemCode: '', group: 'others', lineNo: 2, description: '' }],
    });
    expect(codes(problems)).toContain('so_line_no_product');
    expect(problems.find((p) => p.code === 'so_line_no_product')?.message).toContain('Line 2');
  });

  it('a free-text line (blank code, text riding in description) blocks confirm and names the text', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: ' ', group: 'others', description: 'Square pillow Col: BO315-22' }],
    });
    expect(codes(problems)).toEqual(['so_line_no_product']);
    expect(problems[0]!.message).toContain('Square pillow Col: BO315-22');
  });

  it('a non-catalog code blocks confirm', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'NOPE-1', group: 'others' }],
      nonCatalogCodes: ['NOPE-1'],
    });
    expect(codes(problems)).toEqual(['so_line_not_catalog']);
    expect(problems[0]!.message).toContain('NOPE-1');
  });

  /* ── THE BOUNDARY (owner 2026-08-13) ────────────────────────────────────
     An order with NO Processing Date has not been proceeded, so nothing here
     may ask whether it is buildable. These four are the shapes the 2026-08-08
     gate refused; every one of them is a legitimate confirmed order. */
  it('a bedframe with NO variant selections at all still confirms — not proceeded yet', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'Y103-(Q)', group: 'bedframe' }],
    });
    expect(problems).toEqual([]);
  });

  it('a sofa with no seat height and no fabric still confirms', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: '9028-1A(LHF)', group: 'sofa' }],
    });
    expect(problems).toEqual([]);
  });

  it('a colour-KIV sofa confirms (it blocks the Processing Date, never confirm)', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'SOFA-1', group: 'sofa' }],
    });
    expect(problems).toEqual([]);
  });

  it('service / mattress / accessory / others lines pass, as they always did', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [
        { itemCode: 'SVC-DELIVERY', group: 'service' },
        { itemCode: 'AKKA-FIRM', group: 'mattress' },
        { itemCode: 'PILLOW-1', group: 'accessory' },
        { itemCode: 'MISC-1', group: 'others' },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('every failure reports at once (aggregated, not first-only)', () => {
    const problems = collectSoConfirmProblems({
      salespersonId: null,
      agent: null,
      venue: null,
      venueId: null,
      lines: [
        { itemCode: '', group: 'others' },
        // spec-incomplete, and deliberately NOT a problem here
        { itemCode: 'Y103-(Q)', group: 'bedframe' },
      ],
    });
    expect(codes(problems)).toEqual([
      'salesperson_required', 'venue_required', 'so_line_no_product',
    ]);
  });

  it('no problem this gate can raise is ever about a variant', () => {
    const problems = collectSoConfirmProblems({
      salespersonId: null, agent: null, venue: null, venueId: null,
      lines: [
        { itemCode: '', group: 'bedframe' },
        { itemCode: 'NOPE-1', group: 'sofa' },
        { itemCode: 'Y103-(Q)', group: 'bedframe' },
      ],
      nonCatalogCodes: ['NOPE-1'],
    });
    expect(problems.some((p) => p.code === 'variants_incomplete')).toBe(false);
  });
});

/* ── IO wrapper: loads the header + non-cancelled lines + catalog membership,
   scoped to the SO's OWN company. Mock supabase in the house style.
   `broken` names tables whose read answers with a PostgREST error — resolved,
   not thrown, exactly as supabase-js reports a failure. */
type Row = Record<string, unknown> & { _table: string };
const makeSb = (rows: Row[], broken: string[] = []) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const err = broken.includes(table) ? { message: `connection reset (${table})` } : null;
    const run = () => rows
      .filter((r) => r._table === table)
      .filter((r) => eqs.every(([col, v]) => r[col] === v))
      .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, vs]); return builder; },
      maybeSingle: async () => (err ? { data: null, error: err } : { data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[] | null; error: unknown }) => void) =>
        resolve(err ? { data: null, error: err } : { data: run(), error: null }),
    };
    return builder;
  },
});

describe('soConfirmProblemsForDoc', () => {
  const fixtures: Row[] = [
    {
      _table: 'mfg_sales_orders', doc_no: 'HC-SO-2607-013',
      salesperson_id: 'staff-1', agent: null, venue: 'PJ', venue_id: null, company_id: 1,
    },
    {
      _table: 'mfg_sales_order_items', doc_no: 'HC-SO-2607-013',
      item_code: 'FOREIGN-1', item_group: 'others', variants: null,
      description: null, line_no: 1, cancelled: false,
    },
    {
      _table: 'mfg_sales_order_items', doc_no: 'HC-SO-2607-013',
      item_code: 'CANCELLED-1', item_group: 'bedframe', variants: null,
      description: null, line_no: 2, cancelled: true,
    },
    // FOREIGN-1 exists ONLY in the other company's catalog.
    { _table: 'mfg_products', code: 'FOREIGN-1', company_id: 2 },
  ];

  it('a code held only by the OTHER company is not-catalog for this order', async () => {
    const problems = await soConfirmProblemsForDoc(makeSb(fixtures), 'HC-SO-2607-013');
    expect(codes(problems)).toEqual(['so_line_not_catalog']);
  });

  it('cancelled lines are ignored (the incomplete bedframe above never reports)', async () => {
    const problems = await soConfirmProblemsForDoc(makeSb(fixtures), 'HC-SO-2607-013');
    expect(problems.some((p) => p.line === 'CANCELLED-1')).toBe(false);
  });

  it('a same-company code passes', async () => {
    const withOwn = [...fixtures, { _table: 'mfg_products', code: 'FOREIGN-1', company_id: 1 } as Row];
    expect(await soConfirmProblemsForDoc(makeSb(withOwn), 'HC-SO-2607-013')).toEqual([]);
  });

  /* ── A GATE THAT COULD NOT LOOK DOES NOT SAY "ALL CLEAR" ─────────────────
     An EMPTY problem list is what the caller spends as permission to confirm
     the draft and enqueue it to AutoCount (mfg-sales-orders.ts, the
     DRAFT→CONFIRMED transition: `if (confirmProblems.length > 0) return 422`).

     The lines read was the dangerous one: `items ?? []` turned a failed query
     into an order with NO lines, every per-line rule then had nothing to object
     to, and the gate returned []. These tests make each read REJECT and assert
     the gate returns a PROBLEM. If the error binding is dropped again they
     fail — the lines case with a bare [], which is the bug itself. */
  const clean: Row[] = [
    {
      _table: 'mfg_sales_orders', doc_no: 'HC-SO-2607-013',
      salesperson_id: 'staff-1', agent: null, venue: 'PJ', venue_id: null, company_id: 1,
    },
    {
      _table: 'mfg_sales_order_items', doc_no: 'HC-SO-2607-013',
      item_code: 'GOOD-1', item_group: 'others', description: null, line_no: 1, cancelled: false,
    },
    { _table: 'mfg_products', code: 'GOOD-1', company_id: 1 },
  ];

  it('the clean order confirms — so the refusals below are the read, not the order', async () => {
    expect(await soConfirmProblemsForDoc(makeSb(clean), 'HC-SO-2607-013')).toEqual([]);
  });

  it('an unreadable LINES read refuses instead of confirming a lineless order', async () => {
    const problems = await soConfirmProblemsForDoc(makeSb(clean, ['mfg_sales_order_items']), 'HC-SO-2607-013');
    expect(codes(problems)).toEqual(['so_confirm_check_failed']);
    expect(problems[0]!.message).toContain('connection reset');
  });

  it('an unreadable HEADER read refuses, and says so rather than blaming the salesperson', async () => {
    const problems = await soConfirmProblemsForDoc(makeSb(clean, ['mfg_sales_orders']), 'HC-SO-2607-013');
    // It always refused (an empty header reads as "no salesperson"); what
    // changed is that it now names what actually happened.
    expect(codes(problems)).toEqual(['so_confirm_check_failed']);
    expect(codes(problems)).not.toContain('salesperson_required');
  });

  it('an unreadable CATALOG read refuses, and does not call every code non-catalog', async () => {
    const problems = await soConfirmProblemsForDoc(makeSb(clean, ['mfg_products']), 'HC-SO-2607-013');
    expect(codes(problems)).toEqual(['so_confirm_check_failed']);
    expect(codes(problems)).not.toContain('so_line_not_catalog');
  });
});
