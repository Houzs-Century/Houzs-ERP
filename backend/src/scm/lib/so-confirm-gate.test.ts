import { describe, expect, it } from 'vitest';
import { collectSoConfirmProblems, soConfirmProblemsForDoc } from './so-confirm-gate';

/* ═══════════════════════════════════════════════════════════════════════════
   The confirm gate (owner rulings 2026-08-08): a Sales Order may only become
   CONFIRMED with a salesperson, a venue, every line a REAL catalog SKU, and
   every goods line's required variant axes filled (colour-KIV satisfies the
   fabric axis — KIV blocks the Processing Date, not confirm).
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
      variants: { divanHeight: '5"', legHeight: '6"', gap: '2"', fabricCode: 'BO315-22' },
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
      lines: [...GOOD.lines, { itemCode: '', group: 'others', variants: null, lineNo: 2, description: '' }],
    });
    expect(codes(problems)).toContain('so_line_no_product');
    expect(problems.find((p) => p.code === 'so_line_no_product')?.message).toContain('Line 2');
  });

  it('a free-text line (blank code, text riding in description) blocks confirm and names the text', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: ' ', group: 'others', variants: null, description: 'Square pillow Col: BO315-22' }],
    });
    expect(codes(problems)).toEqual(['so_line_no_product']);
    expect(problems[0]!.message).toContain('Square pillow Col: BO315-22');
  });

  it('a non-catalog code blocks confirm', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'NOPE-1', group: 'others', variants: null }],
      nonCatalogCodes: ['NOPE-1'],
    });
    expect(codes(problems)).toEqual(['so_line_not_catalog']);
    expect(problems[0]!.message).toContain('NOPE-1');
  });

  it('a bedframe with no variant selections at all reports every required axis (HC-SO-2607-008)', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'Y103-(Q)', group: 'bedframe', variants: null }],
    });
    expect(codes(problems)).toEqual([
      'variants_incomplete', 'variants_incomplete', 'variants_incomplete', 'variants_incomplete',
    ]);
    expect(problems.map((p) => p.field)).toEqual(['Divan Height', 'Leg Height', 'Gap', 'Fabrics']);
  });

  it('colour-KIV satisfies the fabric axis (KIV blocks the Processing Date, never confirm)', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{
        itemCode: 'SOFA-1',
        group: 'sofa',
        variants: { seatHeight: '28', fabricId: 'f-1', fabricLabel: 'EZ' },
      }],
    });
    expect(problems).toEqual([]);
  });

  it('the POS vocabulary satisfies the sofa axes (depth == seatHeight)', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [{ itemCode: 'SOFA-1', group: 'sofa', variants: { depth: '28', fabricCode: 'EZ-01' } }],
    });
    expect(problems).toEqual([]);
  });

  it('service / mattress / accessory / others lines carry no axes and pass', () => {
    const problems = collectSoConfirmProblems({
      ...GOOD,
      lines: [
        { itemCode: 'SVC-DELIVERY', group: 'service', variants: null },
        { itemCode: 'AKKA-FIRM', group: 'mattress', variants: null },
        { itemCode: 'PILLOW-1', group: 'accessory', variants: null },
        { itemCode: 'MISC-1', group: 'others', variants: null },
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
        { itemCode: '', group: 'others', variants: null },
        { itemCode: 'Y103-(Q)', group: 'bedframe', variants: null },
      ],
    });
    expect(codes(problems)).toEqual([
      'salesperson_required', 'venue_required', 'so_line_no_product',
      'variants_incomplete', 'variants_incomplete', 'variants_incomplete', 'variants_incomplete',
    ]);
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
   THE ITEMCODE EXEMPTIONS — owner 2026-08-09 (DIVAN ONLY) and 2026-08-10
   (electric / pull-out beds: "电动床/抽拉床…像 DIVAN ONLY 一样豁免 — 要").

   These products physically have no divan base, so there is no Divan Height,
   Leg Height or Gap to state. missingVariantAxes reads the itemCode to skip
   those axes — and collectSoConfirmProblems was NOT passing it, while computing
   it two lines above and using it for the message. So the exemption worked on
   the Processing-Date gate (so-variant-check.ts passes it) and was dead on the
   confirm gate: a DIVAN ONLY or ADJUSTABLE line with Gap blank could not be
   confirmed at all.

   BUG-HISTORY.md:3913 records that fix as threaded through "every desktop +
   mobile call site". Three of four never got it. Neither repo checker can see
   this class: check-shared-mirrors compares module BODIES, not the arguments
   at a call site.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('confirm gate — itemCode-driven exemptions', () => {
  const base = {
    salespersonId: 'staff-1',
    agent: null,
    venue: 'PJ Showroom',
    venueId: null,
  };

  it('a DIVAN ONLY line confirms with Gap blank', () => {
    const problems = collectSoConfirmProblems({
      ...base,
      lines: [{
        itemCode: 'AKEMI DIVAN ONLY (Q)',
        group: 'bedframe',
        // no gap
        variants: { divanHeight: '10"', legHeight: '6"', fabricCode: 'BO315-22' },
      }],
    } as Parameters<typeof collectSoConfirmProblems>[0]);
    expect(problems).toEqual([]);
  });

  it('an ADJUSTABLE bed confirms with divan height, leg height AND gap blank', () => {
    const problems = collectSoConfirmProblems({
      ...base,
      lines: [{
        itemCode: 'TRION ADJUSTABLE (KING)',
        group: 'bedframe',
        variants: { fabricCode: 'BO315-22' },
      }],
    } as Parameters<typeof collectSoConfirmProblems>[0]);
    expect(problems).toEqual([]);
  });

  it('a pull-out combo (S+S) is exempt the same way', () => {
    const problems = collectSoConfirmProblems({
      ...base,
      lines: [{
        itemCode: 'NOVA (S+S)',
        group: 'bedframe',
        variants: { fabricCode: 'BO315-22' },
      }],
    } as Parameters<typeof collectSoConfirmProblems>[0]);
    expect(problems).toEqual([]);
  });

  it('an ORDINARY bedframe is still blocked — the exemption must not leak', () => {
    const problems = collectSoConfirmProblems({
      ...base,
      lines: [{
        itemCode: 'Y103-(Q)',
        group: 'bedframe',
        variants: { divanHeight: '5"', legHeight: '6"', fabricCode: 'BO315-22' },
      }],
    } as Parameters<typeof collectSoConfirmProblems>[0]);
    expect(problems.map((p) => p.code)).toContain('variants_incomplete');
  });
});
