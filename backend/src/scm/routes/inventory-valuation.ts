// ----------------------------------------------------------------------------
// inventory-valuation — the Inventory page's 选日期 view (GL redesign item 5).
//
// GET /inventory/valuation?asOf=YYYY-MM-DD answers "what did we hold, and what
// was it worth, at the END of that day" — the same business-date replay the
// month-end close runs on (acc/stock-close.ts), grouped per item and joined to
// the product master for names and categories. It deliberately carries NONE of
// the live list's planning columns (incoming / committed / surplus): those are
// questions about the future, and this is a photograph of a past day.
// ----------------------------------------------------------------------------

import { stockBreakdownAsOf } from '../../acc/stock-close';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

export const inventoryValuationHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const asOf = String(c.req.query('asOf') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return c.json({ error: 'bad_date', message: 'asOf must be YYYY-MM-DD.' }, 400);
  }
  const sb = c.get('supabase');

  const br = await stockBreakdownAsOf(sb, co.companyId, asOf);
  if (!br.ok) return c.json({ error: 'load_failed', reason: br.reason }, 500);

  /* Names and categories from the product master, fetched once for the codes
     the replay actually produced. A code the master no longer carries still
     shows — the value existed on that day, and hiding it would make the
     category subtotals disagree with the total. */
  const codes = [...br.items.keys()];
  const nameOf = new Map<string, { name: string | null; category: string | null }>();
  for (let i = 0; i < codes.length; i += 200) {
    const slice = codes.slice(i, i + 200);
    const { data, error } = await paginateAll((from, to) => sb
      .from('mfg_products')
      .select('code, name, category')
      .in('code', slice)
      .range(from, to));
    if (error) return c.json({ error: 'load_failed', reason: (error as { message?: string }).message ?? String(error) }, 500);
    for (const p of (data ?? []) as Array<{ code: string; name: string | null; category: string | null }>) {
      nameOf.set(p.code, { name: p.name, category: p.category });
    }
  }

  const rows = codes
    .map((code) => {
      const v = br.items.get(code) ?? { qty: 0, valueSen: 0 };
      const meta = nameOf.get(code);
      return {
        item_code: code,
        product_name: meta?.name ?? null,
        category: meta?.category ?? null,
        qty: v.qty,
        value_sen: v.valueSen,
      };
    })
    /* A row that came and went entirely before the date nets to zero — noise
       on a photograph. Rows with zero qty but residual value (or the reverse)
       STAY: they are exactly the costing questions worth seeing. */
    .filter((r) => r.qty !== 0 || r.value_sen !== 0)
    .sort((a, b) => a.item_code.localeCompare(b.item_code));

  return c.json({
    asOf,
    totalQty: rows.reduce((s, r) => s + r.qty, 0),
    totalValueSen: rows.reduce((s, r) => s + r.value_sen, 0),
    rows,
  });
};
