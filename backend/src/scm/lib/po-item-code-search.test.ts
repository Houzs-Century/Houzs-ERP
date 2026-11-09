import { describe, expect, it } from 'vitest';
import { poIdsByItemCode, withPoSearchIds, PO_SEARCH_ID_CAP } from './po-item-code-search';
import { filterPoList, readPoListFilters, type PoListFilters } from './po-list-read';

// Hookka #460: the PO list search finds an order by an item code on its lines.

const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as { get(key: string): unknown };

/** A fake PostgREST client: `purchase_orders.limit` answers the item-code read,
 *  `mfg_sales_orders.limit` the SO-reference read (empty unless given). */
function fakeSb(rows: { poByCode?: Array<{ id: string }>; soDocNos?: Array<{ doc_no: string }> }) {
  const log: string[] = [];
  const sb = {
    from(table: string) {
      const q: Record<string, unknown> = {
        select: (cols: string) => { log.push(`${table}.select(${cols})`); return q; },
        or: (expr: string) => { log.push(`${table}.or(${expr})`); return q; },
        ilike: (col: string, v: string) => { log.push(`${table}.ilike(${col},${v})`); return q; },
        eq: (col: string, v: unknown) => { log.push(`${table}.eq(${col},${v})`); return q; },
        order: () => q,
        limit: (n: number) => {
          log.push(`${table}.limit(${n})`);
          const data = table === 'purchase_orders' ? rows.poByCode ?? [] : rows.soDocNos ?? [];
          return Promise.resolve({ data, error: null });
        },
        in: () => q,
        range: () => Promise.resolve({ data: [], error: null }),
      };
      return q;
    },
  };
  return { sb: sb as unknown as Parameters<typeof poIdsByItemCode>[0], log };
}

const filters = (q: string | null): PoListFilters => ({ ...readPoListFilters(() => undefined), q });

describe('poIdsByItemCode', () => {
  it('matches the line item code through an inner embed, company-scoped and capped', async () => {
    const { sb, log } = fakeSb({ poByCode: [{ id: 'po-1' }, { id: 'po-1' }, { id: 'po-2' }] });
    expect(await poIdsByItemCode(sb, ctx, ' ASC1010F ', 25)).toEqual(['po-1', 'po-2']);
    expect(log).toContain('purchase_orders.select(id, items:purchase_order_items!inner(item_code))');
    expect(log).toContain('purchase_orders.ilike(items.item_code,%ASC1010F%)');
    expect(log).toContain('purchase_orders.eq(company_id,1)');
    expect(log).toContain('purchase_orders.limit(25)');
  });
  it('a blank term or an exhausted cap reads nothing', async () => {
    const { sb, log } = fakeSb({});
    expect(await poIdsByItemCode(sb, ctx, '  ', 10)).toEqual([]);
    expect(await poIdsByItemCode(sb, ctx, 'X', 0)).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe('withPoSearchIds', () => {
  it('resolves item-code matches within the shared id cap', async () => {
    const { sb, log } = fakeSb({ poByCode: [{ id: 'po-7' }] });
    const out = await withPoSearchIds(sb, ctx, filters('ASC1010F'));
    expect(out.itemCodePoIds).toEqual(['po-7']);
    expect(out.soRefPoIds).toEqual([]);
    expect(log).toContain(`purchase_orders.limit(${PO_SEARCH_ID_CAP})`);
  });
});

describe('filterPoList', () => {
  it('a PO found by item code joins the free-text search as an id arm', () => {
    const calls: string[] = [];
    const self: Record<string, unknown> = {};
    for (const m of ['in', 'eq', 'or', 'gte', 'lte', 'order']) {
      self[m] = (col: string) => { if (m === 'or') calls.push(col); return self; };
    }
    filterPoList(self, { ...filters('ASC1010F'), soRefPoIds: ['po-1'], itemCodePoIds: ['po-7'] }, ctx, new Set());
    expect(calls).toEqual(['po_number.ilike.%ASC1010F%,notes.ilike.%ASC1010F%,id.in.("po-1","po-7")']);
  });
});
