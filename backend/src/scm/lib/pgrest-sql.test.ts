// lib/pgrest-sql — the list closures' PostgREST filters, as the SQL PostgREST
// itself would run for them. The SQL path of the SO / PI list counts and money
// strip depends on every shape below translating exactly; anything it cannot
// translate must refuse (so the route takes its PostgREST path), never guess.
import { describe, expect, it } from 'vitest';
import { PgrestSqlUnsupported, SqlParams, orBodyToSql, selectCol, splitOrTerms, whereOf, type SqlFilterRecorder } from './pgrest-sql';
import { applySoScope } from './salesScope';
import { scopeToCompany } from './companyScope';
import { HELD_OR_TERM } from './document-hold';
import { NOT_CANCELLED_OR } from './list-money-cancelled';
import { brandingFunnelOr } from './so-list-branding-funnel';
import { approvalCodeOrPart } from './so-list-approval-codes';

const company = (id: number | undefined, allowed?: number[]) => ({
  get: (k: string) => (k === 'companyId' ? id : k === 'allowedCompanyIds' ? allowed : undefined),
});

function compile(apply: (q: SqlFilterRecorder) => unknown) {
  const p = new SqlParams();
  return { where: whereOf(apply, p), values: p.values };
}

describe('scope helpers compile to the predicates PostgREST runs', () => {
  it('company scope is an equality on company_id, and fail-closed matches nothing', () => {
    expect(compile((q) => scopeToCompany(q, company(7)))).toEqual({ where: 't."company_id" = $1', values: ['7'] });
    expect(compile((q) => scopeToCompany(q, company(undefined, [])))).toEqual({ where: 'FALSE', values: [] });
    expect(compile((q) => scopeToCompany(q, company(undefined)))).toEqual({ where: 'TRUE', values: [] });
  });

  it('sales scope is one overlap-or-open group with the array literal intact', () => {
    expect(compile((q) => applySoScope(q, ['a1', 'b2']))).toEqual({
      where: '(t."access_staff_ids" && $1 OR t."open_to_all" IS TRUE)',
      values: ['{a1,b2}'],
    });
    expect(compile((q) => applySoScope(q, null))).toEqual({ where: 'TRUE', values: [] });
  });

  it('the held marker and the not-cancelled money term', () => {
    expect(compile((q) => q.or(HELD_OR_TERM))).toEqual({ where: '(t."on_hold" IS TRUE OR t."status" = $1)', values: ['ON_HOLD'] });
    expect(compile((q) => q.or(NOT_CANCELLED_OR))).toEqual({ where: '(t."status" IS NULL OR t."status" <> $1)', values: ['CANCELLED'] });
  });

  it('chained filters AND together, parameters numbered in call order', () => {
    const out = compile((q) => scopeToCompany(applySoScope(q, ['s']), company(1)).in('status', ['CONFIRMED', 'DELIVERED']).gte('so_date', '2026-01-01'));
    expect(out.where).toBe('(t."access_staff_ids" && $1 OR t."open_to_all" IS TRUE) AND t."company_id" = $2 AND t."status" IN ($3, $4) AND t."so_date" >= $5');
    expect(out.values).toEqual(['{s}', '1', 'CONFIRMED', 'DELIVERED', '2026-01-01']);
  });
});

describe('or= grammar', () => {
  it('ilike patterns keep % and read * as %, values with dots stay whole', () => {
    const p = new SqlParams();
    expect(orBodyToSql('doc_no.ilike.%SO-2601.1%,debtor_name.ilike.*tan*', p)).toBe('(t."doc_no" ILIKE $1 OR t."debtor_name" ILIKE $2)');
    expect(p.values).toEqual(['%SO-2601.1%', '%tan%']);
  });

  it('quoted in-lists keep commas, quotes and parentheses inside a value', () => {
    const p = new SqlParams();
    expect(orBodyToSql(brandingFunnelOr(['A,B', 'x"y (z)'], false)!, p)).toMatch(/^\(t."branding" IN \(\$1, \$2\)/);
    expect(p.values.slice(0, 2)).toEqual(['A,B', 'x"y (z)']);
  });

  it('the approval-code in-list term', () => {
    const p = new SqlParams();
    expect(orBodyToSql(approvalCodeOrPart(['SO-1', 'SO-2'])!, p)).toBe('(t."doc_no" IN ($1, $2))');
    expect(p.values).toEqual(['SO-1', 'SO-2']);
  });

  it('nested and() / not. groups, and braces do not split', () => {
    const p = new SqlParams();
    expect(orBodyToSql('amended_delivery_date.lt.2026-11-10,and(amended_delivery_date.is.null,customer_delivery_date.lt.2026-11-10)', p))
      .toBe('(t."amended_delivery_date" < $1 OR (t."amended_delivery_date" IS NULL AND t."customer_delivery_date" < $2))');
    expect(splitOrTerms('so_line_warehouse_ids.ov.{w1,w2},city.in.("",x),not.and(a.eq.1,b.eq.2)'))
      .toEqual(['so_line_warehouse_ids.ov.{w1,w2}', 'city.in.("",x)', 'not.and(a.eq.1,b.eq.2)']);
    const q = new SqlParams();
    expect(orBodyToSql('not.and(a.eq.1,b.neq.2),c.not.in.(X,Y)', q)).toBe('(NOT (t."a" = $1 AND t."b" <> $2) OR NOT (t."c" IN ($3, $4)))');
  });

  it('is.null / true / false, and an empty in-list matches nothing', () => {
    const p = new SqlParams();
    expect(orBodyToSql('a.is.null,b.is.true,c.is.false,d.in.()', p)).toBe('(t."a" IS NULL OR t."b" IS TRUE OR t."c" IS FALSE OR FALSE)');
  });
});

describe('computed fields are called on the row, as PostgREST does', () => {
  it('a line-warehouse / category / amendment filter calls the scm function on t', () => {
    const out = compile((q) => q.overlaps('so_line_warehouse_ids', ['w1']).overlaps('so_line_categories', ['SOFA']).is('so_has_open_amendment', false));
    expect(out.where).toBe('scm.so_line_warehouse_ids(t) && $1 AND scm.so_line_categories(t) && $2 AND scm.so_has_open_amendment(t) IS FALSE');
    expect(selectCol('so_line_warehouse_ids')).toBe('scm.so_line_warehouse_ids(t) AS "so_line_warehouse_ids"');
    expect(selectCol('city')).toBe('t."city"');
  });
});

describe('builder methods', () => {
  it('not / filter / overlaps / is / ilike', () => {
    const out = compile((q) => q
      .not('status', 'in', '(SHIPPED,DELIVERED)')
      .not('linked_ac_docno', 'is', null)
      .filter('linked_ac_docno', 'in', '("A,1",B)')
      .overlaps('so_line_categories', ['SOFA'])
      .is('so_has_open_amendment', true)
      .ilike('debtor_name', '%ali%')
      .lt('created_at', '2026-01-01T00:00:00+08:00'));
    expect(out.where).toBe('NOT (t."status" IN ($1, $2)) AND NOT (t."linked_ac_docno" IS NULL) AND t."linked_ac_docno" IN ($3, $4)'
      + ' AND scm.so_line_categories(t) && $5 AND scm.so_has_open_amendment(t) IS TRUE AND t."debtor_name" ILIKE $6 AND t."created_at" < $7');
    expect(out.values).toEqual(['SHIPPED', 'DELIVERED', 'A,1', 'B', '{SOFA}', '%ali%', '2026-01-01T00:00:00+08:00']);
  });

  it('values travel as text so Postgres casts them to the column type, as PostgREST does', () => {
    expect(compile((q) => q.eq('company_id', 3).gt('balance_sen_live', 0).eq('open_to_all', true)).values).toEqual(['3', '0', 'true']);
  });
});

describe('what cannot be translated is refused, never guessed', () => {
  const refuses = (apply: (q: SqlFilterRecorder) => unknown) => expect(() => compile(apply)).toThrow(PgrestSqlUnsupported);
  it('embedded-resource columns, unknown operators and methods, null comparisons', () => {
    refuses((q) => q.in('supplier.name', ['X']));
    refuses((q) => q.or('name.fts.foo'));
    refuses((q) => (q as unknown as { textSearch(c: string, v: string): unknown }).textSearch('name', 'x'));
    refuses((q) => q.eq('status', null));
    refuses((q) => q.or('a.eq.1', { foreignTable: 'supplier' }));
    refuses((q) => q.or('a.is.maybe'));
    refuses(() => ({}));
  });
});

describe('every list statement bypasses the Hyperdrive read cache', () => {
  it('names now() in its WHERE, so a pill never lags the page under it', async () => {
    const { soListKpiStatements } = await import('./so-list-kpis-sql');
    const { statusCountsStatement } = await import('./list-status-counts-sql');
    const { soCustomerRowsStatement } = await import('./so-customers-sql');
    const { soFunnelStatements } = await import('./so-funnel-values-sql');
    const id = <T>(q: T): T => q;
    const kpi = soListKpiStatements({ scoped: id, header: id, countFrom: 'mfg_sales_orders' }, true);
    const funnel = soFunnelStatements(['doc_no'], id);
    for (const text of [kpi.counts.text, kpi.money.text, statusCountsStatement('purchase_invoices', id).text,
      soCustomerRowsStatement(id).text, funnel.view.text, funnel.base.text]) {
      expect(text).toContain('WHERE now() IS NOT NULL AND ');
    }
  });
});
