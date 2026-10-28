import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { canViewAllSales } from '../../lib/houzs-perms';
import { chunkIn } from '../../lib/paginate-all';
import { monthBoundsMy, rangeBoundsMy, todayMyt } from '../../lib/my-time';
import { escapeForOr } from '../../lib/postgrest-search';
import { resolveCallerStaffId } from '../../lib/salesScope';
import { resolveOwnerStaffId } from '../pwp-codes';

/* GET /my-mtd, GET /mine — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerMineRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
/* Salesperson MTD scoreboard — feeds the mobile Profile v7 tiles
   (Orders MTD / Sales MTD). Self-scoped the same way as '/mine':
   salesperson_id === auth user id, on the caller's RLS-scoped client, so a
   caller only ever sees their OWN orders. Counts orders created within the
   current Malaysia-calendar month, excluding CANCELLED / DRAFT (not real
   sales). Registered BEFORE '/:docNo' so 'my-mtd' is never a doc-no param. */
mfgSalesOrders.get('/my-mtd', async (c) => {
  const sb = c.get('supabase');
  /* Self = the caller's REAL scm.staff uuid (mig 0066), NOT user.id — the
     bridge pins user.id to the shared system staff row, so matching on it
     returned the SAME (system-attributed) orders for every caller instead
     of the person's own. No sync row → zero stats, not someone else's. */
  const myStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  if (!myStaffId) return c.json({ mtd_orders: 0, mtd_sales_sen: 0 });
  // Current month in Malaysia time → UTC [start, end) bounds for created_at.
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

/* POS "My orders" board — the salesperson's OWN Sales Orders, lightweight
   columns for the 3-status board (Order Placed / Proceed / Delivered).
   Filtered by salesperson_id = caller (staff.id === auth.users.id, schema.ts
   line 162; the POS handover writes the placing salesperson's id into
   salesperson_id) so a POS tablet sees only its own orders WITHOUT relying on
   an RLS SELECT policy. Excludes CANCELLED / ON_HOLD (mirrors the legacy
   board's cancelled exclusion). Registered BEFORE '/:docNo' so 'mine' is never
   captured as a doc-no param. */
mfgSalesOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  /* Read the BASE table (NOT the mfg_sales_orders_with_payment_totals view): a
     Postgres view fixes its column list at creation, so any column newer than
     the last recreation is missing and selecting one 500s at runtime. Paid is
     summed from the payments ledger separately below. */
  /* Board filters (POS My-orders toolbar):
       ?q=   free-text → searches doc_no / debtor_name / phone across ALL dates
             (the period is intentionally ignored — search is a global lookup).
       ?from=&to=  YYYY-MM-DD (MY-local, `to` inclusive) → filter created_at
             (order-placed date) to that period. Only applied when there's no q.
     The default (no params) returns everything; the POS always passes the
     current-month window, so the board mirrors the KPI cards. */
  const q = (c.req.query('q') ?? '').trim();
  const fromYmd = c.req.query('from') ?? null;
  const toYmd = c.req.query('to') ?? null;
  const LIMIT = 300;

  /* ?salesperson=<id|all> — only view-all roles (super_admin / sales_director /
     outlet_manager) may view OTHER salespeople. We verify the caller's role with a service-role
     lookup; if they qualify we run the whole board on the service-role client
     (so RLS can't clip another salesperson's rows/items/payments). Everyone
     else: the param is ignored and they stay self-scoped on their own client. */
  const wantSalesperson = c.req.query('salesperson') ?? null;
  /* Self = the caller's REAL scm.staff uuid (mig 0066) — never user.id, the
     bridge's pinned system row shared by every caller (see /my-mtd note). The
     old `?? user.id` handed an unresolved caller every order ever mis-stamped
     with that pin, i.e. other people's orders on a board called "mine". */
  let targetSalespersonId: string | null = await resolveOwnerStaffId(sb, c.get('houzsUser')?.id, user.id);
  /* `null` below means NO salesperson filter (see the .eq guard), i.e. EVERY
     order — so "unresolved" and "deliberately unscoped" must never be the same
     value. Only a view-all caller asking for ?salesperson=all earns the second. */
  let viewingAll = false;
  if (wantSalesperson) {
    // Same view-all tier as the rest of this file (:772, :1161, :1877):
    // `scm.so.view_all` OR a director position, via canViewAllSales.
    // No client swap here: `sb` IS the service-role client already
    // (getSupabaseService), pointed at db.schema 'scm'. The ported 2990 branch
    // built a raw createClient() for RLS bypass — which defaults to the PUBLIC
    // schema, where mfg_sales_orders has no company_id, so the first caller to
    // ever pass this gate got a 500 instead of a board.
    if (canViewAllSales(c)) {
      viewingAll = wantSalesperson === 'all';
      targetSalespersonId = viewingAll ? null : wantSalesperson;
    }
  }
  /* Unidentified caller, self-scoped → an EMPTY board, matching /my-mtd's zeroes
     directly above. Falling through would drop the filter and show them the
     whole book. */
  if (!targetSalespersonId && !viewingAll) return c.json({ salesOrders: [] });

  let query = scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select(
        'doc_no, debtor_name, phone, email, address1, address2, city, postcode, customer_state, ' +
        'customer_delivery_date, processing_date, status, payment_method, approval_code, note, so_date, created_at, ' +
        'total_revenue_sen, line_count, deposit_sen',
      )
      /* `on_hold` since mig 0324 — the status arm below can no longer see a
         hold, because a held order keeps the status it was on. */
      .eq('on_hold', false)
      .not('status', 'in', '("CANCELLED","ON_HOLD")'), // DRAFT shown on purpose — pairs with /pos/sales-stats; BUG-HISTORY 2026-08-17
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
        `doc_no.ilike.%${safe}%,debtor_name.ilike.%${safe}%,phone.ilike.%${safe}%`,
      );
    }
  } else {
    const { startUtc, endUtc } = rangeBoundsMy(fromYmd, toYmd);
    if (startUtc) query = query.gte('created_at', startUtc);
    if (endUtc) query = query.lt('created_at', endUtc);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if ((data?.length ?? 0) >= LIMIT) {
    console.log(`[/mine] ${LIMIT}-row cap hit caller=${user.id} target=${targetSalespersonId ?? 'all'} q=${q ? 'yes' : 'no'} from=${fromYmd ?? '-'} to=${toYmd ?? '-'}`);
  }

  // Cast via `unknown` first — supabase-js types a view select as
  // GenericStringError[] until the schema cache materialises (same pattern as
  // the list route's joined-select casts above).
  const rows = (data ?? []) as unknown as Array<{ doc_no?: string; deposit_sen?: number } & Record<string, unknown>>;

  /* Attach the line items so the drawer can render the cart without a second
     fetch. Group non-cancelled lines by doc_no → each item the board needs:
     { item_code, description, qty, total_sen, variants }. */
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  /* TBC fill-in (Loo 2026-06-11) — the editor needs the line id (mutation
     target), item_group (which picker set to render) and unit/discount (the
     floor-rule preview), so they ride the same fetch. */
  const itemsByDoc = new Map<string, Array<{ id: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_sen: number; discount_sen: number; total_sen: number; variants: unknown; remark: string | null }>>();
  if (docNos.length > 0) {
    /* chunkIn — `docNos` is this board's whole page (LIMIT 300) and the read had neither batching nor paging, so past the 1000-row cap a later order's drawer rendered empty. */
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

  /* Live paid = the payments ledger, PLUS the header deposit ONLY for legacy
     SOs whose deposit never reached the ledger. Since P2 (D5, migration 0155)
     the SO create path writes the deposit as an is_deposit ledger row (and
     0155 backfilled history), so adding the header column on top would double
     count — the is_deposit marker tells the two worlds apart. The header
     `paid_sen` is deprecated; not read. One batched ledger query. */
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
      // Total received = ledger payments (+ header deposit only when the
      // ledger doesn't already carry it as an is_deposit row).
      paid_sen_total: (depositInLedger.has(docNo) ? 0 : deposit) + ledger,
      items: soItems,
    };
  });

  return c.json({ salesOrders });
});
}
