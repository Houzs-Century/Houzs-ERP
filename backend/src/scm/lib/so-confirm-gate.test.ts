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
   scoped to the SO's OWN company. Mock supabase in the house style. */
type Row = Record<string, unknown> & { _table: string };
const makeSb = (rows: Row[]) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => rows
      .filter((r) => r._table === table)
      .filter((r) => eqs.every(([col, v]) => r[col] === v))
      .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, vs]); return builder; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
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
});

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIRM DOES NOT CHECK VARIANTS — owner ruling, PR #2072 (2026-08-13):
   "variant completeness is the PROCEED rule, and only the proceed rule."

   Worth recording because this branch briefly went the OTHER way. Auditing a
   tree eight commits behind origin/main, I found this gate computing a line's
   itemCode and not passing it to missingConfirmVariantAxes — which killed the
   DIVAN ONLY (2026-08-09) and electric/pull-out bed (2026-08-10) exemptions —
   and fixed the argument. Upstream had answered the same question better on the
   same day by deleting the check outright. The merge took upstream.

   The rule is now enforced by the TYPE, not by a test: SoConfirmLineFacts
   carries itemCode / group / lineNo / description and NO `variants` field at
   all, so this gate cannot read one. That is a stronger guarantee than any
   assertion here could make, and it is why the cases below only pin what the
   gate DOES do. The variant requirement still exists where it belongs, gated on
   the Processing Date (lib/so-variant-check.ts), and that gate does pass
   itemCode — so the exemptions live.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('confirm gate — what it does and does not police', () => {
  const base = { salespersonId: 'staff-1', agent: null, venue: 'PJ Showroom', venueId: null };
  const confirmOf = (lines: Array<Record<string, unknown>>) =>
    collectSoConfirmProblems({ ...base, lines } as unknown as Parameters<typeof collectSoConfirmProblems>[0]);

  it('an ordinary bedframe confirms — variants are not this gate\'s business', () => {
    expect(confirmOf([{ itemCode: 'Y103-(Q)', group: 'bedframe' }])).toEqual([]);
  });

  it('a DIVAN ONLY line confirms', () => {
    expect(confirmOf([{ itemCode: 'AKEMI DIVAN ONLY (Q)', group: 'bedframe' }])).toEqual([]);
  });

  it('an ADJUSTABLE (electric) bed confirms', () => {
    expect(confirmOf([{ itemCode: 'TRION ADJUSTABLE (KING)', group: 'bedframe' }])).toEqual([]);
  });

  it('it still refuses a product-less line — that IS its job', () => {
    expect(confirmOf([{ itemCode: '', group: 'bedframe', lineNo: 1 }]).length).toBeGreaterThan(0);
  });
});
