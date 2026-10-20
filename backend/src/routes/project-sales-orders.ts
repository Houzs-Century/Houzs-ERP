// ----------------------------------------------------------------------------
// project-sales-orders — the Sales Orders written at ONE exhibition, read from
// inside the project page.
//
// WHY (owner 2026-10-13). An order opened in the Sales Order module carries
// `scm.mfg_sales_orders.project_id` — the fair it was written at — but the
// project's own Sales section listed only its `sales_entries` drafts. An event
// with sixty orders keyed in still read "No sales drafted yet", and its Total
// was the lump sum typed into Total Sales, so nobody could see per event how
// much of that final total had actually been opened as orders and how much was
// still sitting on paper slips.
//
//   GET /api/project-sales-orders/:projectId
//     { data: [...orders], totals: { count, draft_count, amount_sen, paid_sen,
//       balance_sen }, scoped }
//
// GATE. index.ts puts `requirePageAccessOrSalesView("sales")` in front of this
// prefix — the SAME read gate as GET /api/sales/entries — so the section's
// viewers and this read admit exactly the same people. The SCM bridge
// (supabaseAuth) then supplies the scm-schema client and the real caller.
// ROW SCOPE is the Sales Order module's own (lib/salesScope): a full-access,
// director or view-all caller sees every order of the fair; everyone else
// their own + downline and the orders flagged open to all. `scoped` tells the
// page its totals are that partial view, never the fair's.
//
// Its own prefix, not /api/projects: routes/projects.ts is at its size ceiling,
// and a `use('*', supabaseAuth)` mounted under /api/projects would replace
// `user` with the pinned scm.staff identity for every projects request that
// fell through it (the double-mount fault supabaseAuth's header describes).
//
// The BASE table, not the payment-totals view: the view's column set is frozen
// at CREATE VIEW time and `project_id` is not known to be on it (the view trap,
// backend/docs/scm-view-trap-coe.md). Paid comes from the payment ledger
// through the shared rule in scm/shared/so-outstanding.ts — the one the SO
// detail and the Fair Report already use — so this surface cannot print a
// third balance.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Variables } from "../scm/env";
import { supabaseAuth } from "../scm/middleware/auth";
import { activeCompanySql, scopeToCompany } from "../scm/lib/companyScope";
import { loadFairsByIds, type FairDb } from "../scm/lib/fair-binding";
import { sameVenue } from "../scm/lib/fair-options";
import { canViewAllSales } from "../scm/lib/houzs-perms";
import { resolveSalesScopeIds, applySoScope } from "../scm/lib/salesScope";
import { paginateAll, chunkIn, type PageResult } from "../scm/lib/paginate-all";
import {
  soDisplayTotalSen,
  soPaidSen,
  soPaidInputsOf,
  signedBalanceSen,
} from "../scm/shared/so-outstanding";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/* Header columns this read needs — all on the base table. `debtor_name` and
   `phone` are the order's denormalised customer: an SO carries no customers
   join (mfg-sales-orders.ts, the "customers table" note by its list). */
const SO_COLS =
  "doc_no, so_date, ref, customer_so_no, debtor_name, phone, status, salesperson_id, " +
  "local_total_sen, total_revenue_sen, deposit_sen, service_sen, fair_match, linked_ac_docno, created_at, venue";

type SoRow = {
  doc_no: string;
  so_date: string | null;
  ref: string | null;
  /** The booklet number as the rep typed it in Ref No. on a new order; `ref`
   *  is where an order migrated from AutoCount carries it. */
  customer_so_no: string | null;
  debtor_name: string | null;
  phone: string | null;
  status: string | null;
  salesperson_id: string | null;
  local_total_sen: number | null;
  service_sen: number | null;
  total_revenue_sen: number | null;
  deposit_sen: number | null;
  fair_match: string | null;
  linked_ac_docno: string | null;
  created_at: string | null;
  venue: string | null;
};

export type ProjectSalesOrderRow = {
  doc_no: string;
  so_date: string | null;
  ref: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  salesperson_name: string | null;
  status: string;
  amount_sen: number;
  paid_sen: number;
  balance_sen: number;
  /** The order's service lines, inside amount_sen. */
  service_sen: number;
  fair_match: string | null;
  linked_ac_docno: string | null;
  created_at: string | null;
  /** "Venue differs" (owner 2026-10-19): the venue on the order when it is NOT
   *  this fair's venue — the slip said one place, the order was placed here.
   *  Null when they agree, or when the order carries no venue. */
  venue_differs: string | null;
};

export type ProjectSalesOrderTotals = {
  count: number;
  draft_count: number;
  amount_sen: number;
  paid_sen: number;
  balance_sen: number;
  /** The orders' service lines, inside amount_sen (owner 2026-10-20: the header
   *  splits Sales from Service Revenue, as the Financial Snapshot does). */
  service_sen: number;
};

/** The header tiles' numbers. DRAFT counts as opened — it is keyed in, which is
 *  the question the page asks — and is reported separately so the page can say
 *  so; CANCELLED never reaches here. */
export function projectSalesOrderTotals(rows: readonly ProjectSalesOrderRow[]): ProjectSalesOrderTotals {
  const t: ProjectSalesOrderTotals = { count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0, service_sen: 0 };
  for (const r of rows) {
    t.count += 1;
    if (r.status === "DRAFT") t.draft_count += 1;
    t.amount_sen += r.amount_sen;
    t.paid_sen += r.paid_sen;
    t.balance_sen += r.balance_sen;
    t.service_sen += r.service_sen;
  }
  return t;
}

export async function projectSalesOrdersHandler(c: Ctx): Promise<Response> {
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return c.json({ error: "invalid_project_id" }, 400);
  }
  const sb = c.get("supabase");

  /* View-all = the entries list's own rule (page access `full` lifts its
     ownership filter) OR the SO module's (scm.so.view_all / a director
     position). Everyone else is held to the SO module's own + downline scope. */
  const viewAll = c.get("access_level") === "full" || canViewAllSales(c);
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get("houzsUser")?.id, viewAll);

  const { data, error } = await paginateAll<SoRow>((from, to) => {
    let q = sb
      .from("mfg_sales_orders")
      .select(SO_COLS)
      .eq("project_id", projectId)
      .neq("status", "CANCELLED")
      .order("so_date", { ascending: false })
      .order("doc_no", { ascending: false });
    q = applySoScope(q, scopeIds);
    q = scopeToCompany(q, c);
    /* The untyped scm client types a select string as an error row; the shape
       is SO_COLS above. */
    return q.range(from, to) as unknown as PromiseLike<PageResult<SoRow>>;
  });
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  const headers = data ?? [];

  /* Paid is the LEDGER, never the header's paid_sen / balance_sen (neither is
     maintained — so-outstanding.ts). One batched read for the whole fair. */
  const ledger = new Map<string, { paidSen: number; depositInLedger: boolean }>();
  const docNos = headers.map((h) => h.doc_no);
  if (docNos.length > 0) {
    const { data: pays, error: payErr } = await chunkIn<{ so_doc_no: string; amount_sen: number | null; is_deposit: boolean | null }>(
      docNos,
      (batch, from, to) =>
        scopeToCompany(
          sb.from("mfg_sales_order_payments").select("so_doc_no, amount_sen, is_deposit").in("so_doc_no", batch),
          c,
        ).range(from, to),
    );
    if (payErr) return c.json({ error: "load_failed", reason: payErr.message }, 500);
    for (const p of pays) {
      const cur = ledger.get(p.so_doc_no) ?? { paidSen: 0, depositInLedger: false };
      cur.paidSen += Number(p.amount_sen ?? 0);
      if (p.is_deposit === true) cur.depositInLedger = true;
      ledger.set(p.so_doc_no, cur);
    }
  }

  /* salesperson_id is an scm.staff uuid; the page wants the name. */
  const staffNames = new Map<string, string>();
  const staffIds = Array.from(new Set(headers.map((h) => h.salesperson_id).filter((v): v is string => !!v)));
  if (staffIds.length > 0) {
    const { data: staff, error: staffErr } = await chunkIn<{ id: string; name: string | null }>(
      staffIds,
      (batch, from, to) => sb.from("staff").select("id, name").in("id", batch).range(from, to),
    );
    if (staffErr) return c.json({ error: "load_failed", reason: staffErr.message }, 500);
    for (const s of staff) if (s.id && s.name) staffNames.set(s.id, s.name);
  }

  /* The fair's own venue, for "Venue differs". A display hint only: when PMS
     cannot be read the rows still list, with no flag rather than a wrong one. */
  const db = c.env?.DB as unknown as FairDb | undefined;
  const booth = db
    ? (await loadFairsByIds(db, activeCompanySql(c, "p.company_id"), [projectId]).catch(() => new Map<number, never>())).get(projectId)
    : undefined;
  const venueDiffers = (v: string | null): string | null =>
    v && v.trim() && booth?.venue && !sameVenue(v, booth.venue) ? v.trim() : null;

  const rows: ProjectSalesOrderRow[] = headers.map((h) => {
    const led = ledger.get(h.doc_no);
    const inputs = soPaidInputsOf(h as unknown as Record<string, unknown>, led?.paidSen ?? 0, led?.depositInLedger ?? false);
    const amountSen = soDisplayTotalSen(inputs);
    const paidSen = soPaidSen(inputs);
    return {
      doc_no: h.doc_no,
      so_date: h.so_date,
      ref: h.customer_so_no || h.ref,
      customer_name: h.debtor_name,
      customer_phone: h.phone,
      salesperson_name: h.salesperson_id ? staffNames.get(h.salesperson_id) ?? null : null,
      status: h.status ?? "",
      amount_sen: amountSen,
      service_sen: Number(h.service_sen ?? 0),
      paid_sen: paidSen,
      balance_sen: signedBalanceSen(amountSen, paidSen),
      fair_match: h.fair_match,
      linked_ac_docno: h.linked_ac_docno,
      created_at: h.created_at,
      venue_differs: venueDiffers(h.venue),
    };
  });

  return c.json({ data: rows, totals: projectSalesOrderTotals(rows), scoped: scopeIds !== null });
}

export const projectSalesOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
projectSalesOrders.use("*", supabaseAuth);
projectSalesOrders.get("/:projectId", projectSalesOrdersHandler);
