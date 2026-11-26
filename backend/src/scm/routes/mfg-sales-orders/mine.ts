import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { canViewAllSales } from '../../lib/houzs-perms';
import { chunkIn } from '../../lib/paginate-all';
import { monthBoundsMy, rangeBoundsMy, todayMyt } from '../../lib/my-time';
import { escapeForOr, phoneSearchOrParts } from '../../lib/postgrest-search';
import { normalizePhone } from '../../shared/phone';
import { applySalesPlace, readSalesPlace } from '../../lib/pos-sales-place';
import { resolveCallerStaffId } from '../../lib/salesScope';
import { resolveOwnerStaffId } from '../pwp-codes';

export function registerMineRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
mfgSalesOrders.get('/my-mtd', async (c) => {
  const sb = c.get('supabase');
  const myStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  if (!myStaffId) return c.json({ mtd_orders: 0, mtd_sales_sen: 0 });
  const ymd = todayMyt();
  const { startUtc, endUtc } = monthBoundsMy(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1);
  // A single salesperson's monthly orders never approach the 1000-row cap.
  // Company-scoped too (owner 2026-08-10 audit): a rep granted to BOTH
  // companies otherwise sees one pooled MTD figure instead of this company's.
  const { data, error } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('local_total_sen, total_revenue_sen')
      .eq('salesperson_id', myStaffId)
      .not('status', 'in', '("CANCELLED","DRAFT")')
      .gte('created_at', startUtc)
      .lt('created_at', endUtc),
    c,
  ).limit(1000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<{ local_total_sen: number | null; total_revenue_sen: number | null }>;
  const mtd_sales_sen = rows.reduce(
    (sum, r) => sum + Number(r.local_total_sen ?? r.total_revenue_sen ?? 0),
    0,
  );
  return c.json({ mtd_orders: rows.length, mtd_sales_sen });
});

mfgSalesOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  const fromYmd = c.req.query('from') ?? null;
  const toYmd = c.req.query('to') ?? null;
  const place = readSalesPlace(c.req.query('project'), c.req.query('venue'));
  const LIMIT = 300;

  const wantSalesperson = c.req.query('salesperson') ?? null;
  let targetSalespersonId: string | null = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
  let viewingAll = false;
  if (wantSalesperson) {
    if (canViewAllSales(c)) {
      viewingAll = wantSalesperson === 'all';
      targetSalespersonId = viewingAll ? null : wantSalesperson;
    }
  }
  if (!targetSalespersonId && !viewingAll) return c.json({ salesOrders: [] });

  let query = scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select(
        'doc_no, debtor_name, phone, email, address1, address2, city, postcode, customer_state, ' +
        'customer_delivery_date, processing_date, status, payment_method, approval_code, note, so_date, created_at, ' +
        'total_revenue_sen, line_count, deposit_sen',
      )
      .eq('on_hold', false)
      .not('status', 'in', '("CANCELLED","ON_HOLD")'),
    c,
  );
  /* Company scope is NOT optional here (owner 2026-08-10 cross-company audit).
     `sb` is the SERVICE-ROLE client, and the view_all branch above clears
     targetSalespersonId, so without this wrap the query degrades to "every
     non-cancelled SO in the database" — both companies, RLS bypassed, with
     customer PII and total_revenue_sen. */
  if (targetSalespersonId) query = query.eq('salesperson_id', targetSalespersonId);

  if (q) {
    const safe = escapeForOr(q);
    if (safe) {
      query = query.or(
        [`doc_no.ilike.%${safe}%`, `debtor_name.ilike.%${safe}%`, ...phoneSearchOrParts(safe, q, normalizePhone)].join(','),
      );
    }
  } else {
    const { startUtc, endUtc } = rangeBoundsMy(fromYmd, toYmd);
    if (startUtc) query = query.gte('created_at', startUtc);
    if (endUtc) query = query.lt('created_at', endUtc);
    query = applySalesPlace(query, place);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if ((data?.length ?? 0) >= LIMIT) {
    console.log(`[/mine] ${LIMIT}-row cap hit caller=${user.id} target=${targetSalespersonId ?? 'all'} q=${q ? 'yes' : 'no'} from=${fromYmd ?? '-'} to=${toYmd ?? '-'}`);
  }

  const rows = (data ?? []) as unknown as Array<{ doc_no?: string; deposit_sen?: number } & Record<string, unknown>>;

  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  const itemsByDoc = new Map<string, Array<{ id: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_sen: number; discount_sen: number; total_sen: number; variants: unknown; remark: string | null }>>();
  if (docNos.length > 0) {
    const { data: itemRows } = await chunkIn<{ id: string; doc_no: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_sen: number; discount_sen: number; total_sen: number; variants: unknown; remark: string | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_code, item_group, description, qty, unit_price_sen, discount_sen, total_sen, variants, remark')
      .in('doc_no', batch).eq('cancelled', false)
      .order('doc_no').order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }).range(from, to));
    for (const it of itemRows) {
      const arr = itemsByDoc.get(it.doc_no) ?? [];
      arr.push({ id: it.id, item_code: it.item_code, item_group: it.item_group ?? null, description: it.description, qty: it.qty, unit_price_sen: it.unit_price_sen, discount_sen: it.discount_sen, total_sen: it.total_sen, variants: it.variants, remark: it.remark ?? null });
      itemsByDoc.set(it.doc_no, arr);
    }
  }

  const paidLedgerByDoc = new Map<string, number>();
  const depositInLedger = new Set<string>();
  if (docNos.length > 0) {
    const { data: payRows } = await chunkIn<{ so_doc_no: string; amount_sen: number; is_deposit?: boolean | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_payments')
      .select('so_doc_no, amount_sen, is_deposit')
      .in('so_doc_no', batch).order('so_doc_no').range(from, to));
    for (const p of payRows) {
      paidLedgerByDoc.set(p.so_doc_no, (paidLedgerByDoc.get(p.so_doc_no) ?? 0) + (p.amount_sen ?? 0));
      if (p.is_deposit) depositInLedger.add(p.so_doc_no);
    }
  }

  const salesOrders = rows.map((r) => {
    const docNo = r.doc_no ?? '';
    const deposit = typeof r.deposit_sen === 'number' ? r.deposit_sen : 0;
    const ledger = paidLedgerByDoc.get(docNo) ?? 0;
    const soItems = itemsByDoc.get(docNo) ?? [];
    return {
      ...r,
      paid_sen_total: (depositInLedger.has(docNo) ? 0 : deposit) + ledger,
      items: soItems,
    };
  });

  return c.json({ salesOrders });
});
}
