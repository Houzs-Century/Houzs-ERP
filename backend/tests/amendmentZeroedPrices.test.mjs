// The selection behind repair-amendment-zeroed-prices.mjs, pinned predicate by
// predicate. Each one is a line that must NOT be restored if it were dropped:
// an unapproved request, a QTY change, a line that was already RM 0 before the
// swap, a request that actually typed a price, a line re-priced since, or an
// order of another company. The money cases are the real HC-SO-013490 line
// (850000 -> 0 on 2026-09-11) as the apply engine would have written it.
import { describe, expect, it } from 'vitest';

import {
  APPLIED_AMENDMENT_STATUSES, candidateSql, downstreamSql, parseDocNos,
  soLineMoney, doLineMoney, siLineMoney, shapeMismatches,
} from '../scripts/lib/amendment-zeroed-prices.mjs';

const flat = (s) => s.replace(/\s+/g, ' ');

describe('candidateSql — only a line zeroed BY an applied SKU-swap amendment', () => {
  const q = flat(candidateSql());

  it('joins the amendment, its line and the current SO line', () => {
    expect(q).toContain('FROM scm.so_amendments a');
    expect(q).toContain('JOIN scm.so_amendment_lines l ON l.amendment_id = a.id');
    expect(q).toContain('JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no');
    expect(q).toContain('JOIN scm.mfg_sales_order_items i ON i.id = l.sales_order_item_id');
  });

  it('requires an APPLIED amendment, never a request still open or rejected', () => {
    expect(APPLIED_AMENDMENT_STATUSES).toEqual(['SO_APPROVED', 'PO_APPROVED', 'SENT']);
    expect(q).toContain("a.status IN ('SO_APPROVED', 'PO_APPROVED', 'SENT')");
    expect(q).toContain('a.so_approved_at IS NOT NULL');
    expect(q).not.toMatch(/REQUESTED|REJECTED|SUPPLIER_PENDING/);
  });

  it('is a SPEC change whose snapshot price was positive and whose request carried none', () => {
    expect(q).toContain("l.change_type = 'SPEC'");
    expect(q).toContain("COALESCE(l.old_snapshot->>'unitPriceSen', l.old_snapshot->>'unit_price_sen')::bigint > 0");
    expect(q).toContain('COALESCE(l.new_unit_price_sen, 0) = 0');
  });

  it('matches only a line that STILL reads zero — a line re-priced since is left alone', () => {
    expect(q).toContain('i.unit_price_sen = 0');
  });

  it('carries company scope on every table that has it, as the only boundary', () => {
    expect(q).toContain('so.company_id = $1 AND i.company_id = $1 AND a.company_id = $1');
  });

  it('takes an explicit allow-list, and an empty one means every order', () => {
    expect(q).toContain('(cardinality($2::text[]) = 0 OR so.doc_no = ANY($2::text[]))');
  });

  it('returns what the plan prints and the apply needs: snapshot price, old code, current money, version', () => {
    for (const col of ['old_unit_price_sen', 'old_item_code', 'line_id', 'so_version', 'amendment_no', 'amendment_id', 'line_cost_sen', 'discount_sen', 'cancelled']) {
      expect(q).toContain(col);
    }
  });
});

describe('downstreamSql — the live DO and SI lines built from those SO lines', () => {
  const q = flat(downstreamSql());

  it('finds DO lines by so_item_id and SI lines by so_item_id OR through their DO line', () => {
    expect(q).toContain('di.so_item_id = ANY($2::uuid[])');
    expect(q).toContain('(si.so_item_id = ANY($2::uuid[]) OR di.so_item_id = ANY($2::uuid[]))');
  });

  it('skips cancelled documents and scopes both header and line to the company', () => {
    expect(q).toContain("d.status::text <> 'CANCELLED'");
    expect(q).toContain("s.status::text <> 'CANCELLED'");
    expect(q).toContain('di.company_id = $1 AND d.company_id = $1');
    expect(q).toContain('si.company_id = $1 AND s.company_id = $1');
  });
});

describe('parseDocNos', () => {
  it('splits on commas and whitespace, trims, de-duplicates, and reads nothing as nothing', () => {
    expect(parseDocNos('HC-SO-013490, HC-SO-013497 HC-SO-013490')).toEqual(['HC-SO-013490', 'HC-SO-013497']);
    expect(parseDocNos(undefined)).toEqual([]);
    expect(parseDocNos('  ')).toEqual([]);
  });
});

describe('line money — the apply engine\'s arithmetic, not a new one', () => {
  it('SO: HC-SO-013490 line 850000 x 1, cost 101900 — total, inc and balance are one figure, cost untouched', () => {
    expect(soLineMoney({ qty: 1, unitSen: 850000, discountSen: 0, lineCostSen: 101900 })).toEqual({
      unit_price_sen: 850000, discount_sen: 0, total_sen: 850000, total_inc_sen: 850000, balance_sen: 850000, line_margin_sen: 748100,
    });
  });

  it('SO: a stored discount survives and is clamped to the gross, as applySoAmendment clamps it', () => {
    expect(soLineMoney({ qty: 2, unitSen: 100000, discountSen: 25000, lineCostSen: 0 }).total_sen).toBe(175000);
    expect(soLineMoney({ qty: 1, unitSen: 100000, discountSen: 999999, lineCostSen: 0 }).total_sen).toBe(0);
  });

  it('DO: clamped at zero, no tax; SI: tax inside the clamp', () => {
    expect(doLineMoney({ qty: 1, unitSen: 850000, discountSen: 0, lineCostSen: 101900 })).toEqual({ unit_price_sen: 850000, line_total_sen: 850000, line_margin_sen: 748100 });
    expect(siLineMoney({ qty: 1, unitSen: 850000, discountSen: 0, taxSen: 0, lineCostSen: 101900 })).toEqual({ unit_price_sen: 850000, line_total_sen: 850000, line_margin_sen: 748100 });
    expect(siLineMoney({ qty: 1, unitSen: 1000, discountSen: 1500, taxSen: 200, lineCostSen: 0 }).line_total_sen).toBe(0);
  });
});

describe('shapeMismatches — the fresh-connection check asks about VALUES', () => {
  it('names every column that disagrees and is empty when the row carries the figures', () => {
    expect(shapeMismatches({ unit_price_sen: 850000, total_sen: 850000 }, { unit_price_sen: 850000, total_sen: 850000 })).toEqual([]);
    expect(shapeMismatches({ unit_price_sen: 0, total_sen: 850000 }, { unit_price_sen: 850000, total_sen: 850000 })).toEqual(['unit_price_sen: 0 vs 850000']);
    expect(shapeMismatches(null, { unit_price_sen: 1 })).toEqual(['row missing']);
  });
});
