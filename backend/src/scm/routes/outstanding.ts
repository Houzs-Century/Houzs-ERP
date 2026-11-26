// ----------------------------------------------------------------------------
// /outstanding — Unified Outstanding filter API across all doc modules.
// Ported from 2990's apps/api/src/routes/outstanding.ts.
//
// Commander 2026-05-26: "全部都要能 filter 出来 Outstanding 跟非 Outstanding
// 的部分. by date".
//
// Backed by scm.v_*_outstanding views. Each module has its own definition of
// "outstanding". Endpoints:
//   GET /outstanding/po              — POs not fully received
//   GET /outstanding/grn             — GRNs not yet billed
//   GET /outstanding/pi              — PIs not fully paid
//   GET /outstanding/pr              — PRs not yet completed
//   GET /outstanding/so              — SOs not yet delivered/invoiced/closed
//   GET /outstanding/do              — DOs not yet invoiced
//   GET /outstanding/si              — SIs not fully paid
//   GET /outstanding/summary         — counts + totals across all modules
//
// All endpoints accept query params:
//   ?outstanding=true|false|all   (default: true — only outstanding rows)
//   ?from=YYYY-MM-DD              (filter by doc date >= from)
//   ?to=YYYY-MM-DD               (filter by doc date <= to)
//
// HOUZS VENDOR: the v_*_outstanding views exist in the scm schema (verified
// 2026-06-20). They DEGRADE GRACEFULLY — when no docs exist the view simply
// returns 0 rows (the route returns { rows: [] } / a zeroed summary), so the
// Outstanding page never 500s on an empty DB.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";
import { paginateAll } from "../lib/paginate-all";
import { readAggregate } from "../lib/postgrest-aggregate";
import { resolvePoEstimateDates } from "../lib/po-line-export";
import {
  scopeToCompany,
  activeCompanyId,
  scopeToAllowedCompanies,
  companyCodeMap,
  withCompanyCode,
} from "../lib/companyScope";
import { stampOrderDeposit } from "../lib/si-list-stamps";
import { creditNotesOf } from "../lib/si-credit-notes";
import {
  summariseSiOutstanding, unavailableSiSummary, SI_SUMMARY_COLS,
} from "../lib/si-outstanding-summary";
import { reduceAgingSnapshot, type AgingMvRow } from "../lib/ar-aging";
import { stampSoRefs } from "../lib/so-ref-lookup";

export const outstanding = new Hono<{ Bindings: Env; Variables: Variables }>();
outstanding.use("*", supabaseAuth);

const MODULES: Record<string, { view: string; dateCol: string }> = {
  po:  { view: "v_po_outstanding",  dateCol: "po_date" },
  grn: { view: "v_grn_outstanding", dateCol: "received_at" },
  pi:  { view: "v_pi_outstanding",  dateCol: "invoice_date" },
  pr:  { view: "v_pr_outstanding",  dateCol: "return_date" },
  so:  { view: "v_so_outstanding",  dateCol: "so_date" },
  do:  { view: "v_do_outstanding",  dateCol: "do_date" },
  si:  { view: "v_si_outstanding",  dateCol: "invoice_date" },
};

const SO_DOC_KEY: Record<string, string> = { so: "doc_no", do: "so_doc_no", si: "so_doc_no" };

for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
  outstanding.get(`/${slug}`, async (c) => {
    const sb = c.get("supabase");
    const outstandingParam = c.req.query("outstanding");
    const from = c.req.query("from");
    const to = c.req.query("to");

    const { data, error } = await paginateAll((pFrom, pTo) => {
      let q = sb.from(view).select("*").order(dateCol, { ascending: false });
      q = scopeToCompany(q, c);
      if (outstandingParam === "true" || outstandingParam == null) {
        q = q.eq("is_outstanding", true);
      } else if (outstandingParam === "false") {
        q = q.eq("is_outstanding", false);
      }
      if (slug === "si") q = q.neq("status", "DRAFT");
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, to);
      return q.range(pFrom, pTo);
    });
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return c.json({ rows: [] });
      }
      return c.json({ error: "load_failed", reason: error.message }, 500);
    }
    /* The SI rows carry `outstanding_sen` straight off the view, which is
       `total_sen - paid_sen` and therefore blind to a deposit taken on the
       SOURCE SALES ORDER — the same blindness the invoice list had until
       2026-08-23 (docs/bugs/0526-*). Adjusted HERE rather than in the view:
       recreating a view is a NEW object with an empty ACL, which is how 0189
       took the Sales Order list down for every user (CLAUDE.md, *Release
       discipline*), and the allocation is a per-order rule no SQL column can
       express anyway. The stamp is the SAME function the invoice list uses, so
       the two screens cannot drift.

       `so_deposit_applied_sen === null` means the stamp could not read the
       orders; the row then keeps the view's larger figure, which is the only
       direction this page may be wrong in. The customers' credit notes knocked
       off each invoice (`credit_notes_sen`, si-credit-notes.ts) come off the
       same way and degrade the same way. */
    if (slug === 'si') {
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      await stampOrderDeposit(sb, rows, activeCompanyId(c) ?? null);
      for (const r of rows) {
        const less = Math.max(0, Number(r.so_deposit_applied_sen ?? 0)) + creditNotesOf(r);
        if (less > 0) r.outstanding_sen = Math.max(0, Number(r.outstanding_sen ?? 0) - less);
      }
    }
    /* The order's customer reference, so the tab's search finds a row by it
       (owner 2026-09-25). The views carry no ref; reading it beside them
       avoids recreating a view (see the SI note above on why that is avoided). */
    const soKey = SO_DOC_KEY[slug];
    if (soKey) {
      await stampSoRefs(sb, (data ?? []) as Array<Record<string, unknown>>, soKey, (q) => scopeToCompany(q, c), `outstanding/${slug}`);
    }
    return c.json({ rows: data ?? [] });
  });
}

outstanding.get("/po-lines", async (c) => {
  const sb = c.get("supabase");
  const outstandingParam = c.req.query("outstanding");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from("v_po_outstanding_lines")
      .select("*")
      .order("po_date", { ascending: false });
    q = scopeToAllowedCompanies(q, c);
    if (outstandingParam === "true" || outstandingParam == null) {
      q = q.eq("is_outstanding", true);
    } else if (outstandingParam === "false") {
      q = q.eq("is_outstanding", false);
    }
    if (outstandingParam !== "false") q = q.gt("remaining_qty", 0);
    if (from) q = q.gte("po_date", from);
    if (to) q = q.lte("po_date", to);
    return q.range(pFrom, pTo);
  });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return c.json({ rows: [] });
    }
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  /* Estimate Delivery Date 1/2/3 (owner 2026-09-15) — line value, else the PO
     header's, through the one rule the PO line export also uses
     (lib/po-line-export-columns.ts). The view carries neither the header dates
     nor slot 4, so they are read beside it rather than widening the view. */
  const viewRows = (data ?? []) as Array<Record<string, unknown>>;
  const est = await resolvePoEstimateDates(sb, (q) => scopeToAllowedCompanies(q, c), viewRows);
  if (est.error) return c.json({ error: "load_failed", reason: est.error }, 500);
  const codes = companyCodeMap(c);
  const rows = viewRows.map((r) => {
    const [d1, d2, d3] = est.byLineId.get(String(r.po_item_id ?? "")) ?? [null, null, null];
    return withCompanyCode(
      { ...r, estimate_delivery_date_1: d1, estimate_delivery_date_2: d2, estimate_delivery_date_3: d3 },
      codes,
    );
  });
  return c.json({ rows });
});

const SUMMARY_AGG: Record<
  string,
  { pkCol: string; amtCol: string | null; outCol: string | null }
> = {
  po:  { pkCol: "id",     amtCol: "total_sen",       outCol: null },
  grn: { pkCol: "id",     amtCol: null,                outCol: null },
  pi:  { pkCol: "id",     amtCol: "total_sen",       outCol: "outstanding_sen" },
  pr:  { pkCol: "id",     amtCol: null,                outCol: null },
  so:  { pkCol: "doc_no", amtCol: "local_total_sen", outCol: null },
  do:  { pkCol: "id",     amtCol: null,                outCol: null },
  si:  { pkCol: "id",     amtCol: "total_sen",       outCol: "outstanding_sen" },
};

outstanding.get("/summary", async (c) => {
  const sb = c.get("supabase");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const wantSnapshot = c.req.query("snapshot") === "1";

  if (wantSnapshot && !from && !to) {
    const meta = await sb
      .from("mv_ar_aging_meta")
      .select("refreshed_at")
      .limit(1)
      .maybeSingle();
    if (!meta.error) {
      let mvQ = sb
        .from("mv_ar_aging")
        .select("module, cnt, total_sen, total_outstanding_sen");
      mvQ = scopeToCompany(mvQ, c);
      const { data, error } = await mvQ;
      if (!error) {
        const snap = reduceAgingSnapshot((data ?? []) as AgingMvRow[]);
        const si = snap.si as unknown as Record<string, unknown> | undefined;
        if (si) {
          si.deposit_applied = false;
          si.deposit_note = 'Nightly snapshot: deposits taken on the sales orders are not subtracted, so this figure may be too high. Reload without ?snapshot=1 for the live figure.';
        }
        return c.json({
          summary: snap,
          snapshot: true,
          refreshed_at: (meta.data?.refreshed_at as string | null) ?? null,
        });
      }
    }
  }

  const summary: Record<
    string,
    {
      count: number; total_sen?: number; total_outstanding_sen?: number;
      deposit_applied?: boolean; deposit_note?: string | null; unavailable?: true;
    }
  > = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFilters = (q0: any, slug: string, dateCol: string): any => {
    let q = q0.eq("is_outstanding", true);
    q = scopeToCompany(q, c);
    if (slug === "si") q = q.neq("status", "DRAFT");
    if (from) q = q.gte(dateCol, from);
    if (to) q = q.lte(dateCol, to);
    return q;
  };

  for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
    const agg = SUMMARY_AGG[slug];
    let done = false;
    /* SI is the one module whose outstanding figure is not a column. Its SQL
       aggregate sums the view's `total_sen - paid_sen`, which cannot see a
       deposit taken on the source ORDER, so the card sat above a row list that
       already subtracted one and disagreed with it (#2684). The aggregate is
       still computed — it is the ceiling this refines DOWNWARD, and the answer
       it produces says whenever it could not (lib/si-outstanding-summary).
       Every other module keeps the one-request aggregate: the rule does not
       apply to them and there is no reason to make them pay for it. */
    if (slug === "si") {
      const aggRow = agg
        ? await readAggregate(() => applyFilters(
            sb.from(view).select(`cnt:${agg.pkCol}.count(),amt:${agg.amtCol}.sum(),outs:${agg.outCol}.sum()`),
            slug, dateCol,
          ))
        : { data: null, error: { message: "no aggregate configured" } };
      const r0 = ((aggRow.data ?? []) as Array<Record<string, unknown>>)[0] ?? {};
      const aggregate = aggRow.error
        ? null
        : { count: Number(r0.cnt ?? 0), total_sen: Number(r0.amt ?? 0), total_outstanding_sen: Number(r0.outs ?? 0) };
      try {
        summary[slug] = await summariseSiOutstanding(
          sb,
          (pFrom, pTo) => applyFilters(sb.from(view).select(SI_SUMMARY_COLS), slug, dateCol).order("id", { ascending: true }).range(pFrom, pTo),
          activeCompanyId(c) ?? null,
          aggregate,
        );
      } catch (e) {
        summary[slug] = unavailableSiSummary(e instanceof Error ? e.message : String(e));
      }
      continue;
    }

    if (agg) {
      const parts = [`cnt:${agg.pkCol}.count()`];
      if (agg.amtCol) parts.push(`amt:${agg.amtCol}.sum()`);
      if (agg.outCol) parts.push(`outs:${agg.outCol}.sum()`);
      const { data, error } = await readAggregate(() => applyFilters(
        sb.from(view).select(parts.join(",")),
        slug,
        dateCol,
      ));
      if (!error) {
        const row = ((data ?? []) as Array<Record<string, unknown>>)[0] ?? {};
        summary[slug] = {
          count: Number(row.cnt ?? 0),
          total_sen: agg.amtCol ? Number(row.amt ?? 0) : 0,
          total_outstanding_sen: agg.outCol ? Number(row.outs ?? 0) : 0,
        };
        done = true;
      }
    }

    if (!done) {
      const { data } = await paginateAll((pFrom, pTo) =>
        applyFilters(sb.from(view).select("*"), slug, dateCol).order(agg?.pkCol ?? "id", { ascending: true }).range(pFrom, pTo),
      );
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      summary[slug] = {
        count: rows.length,
        total_sen: rows.reduce(
          (s, r) => s + Number(r.total_sen ?? r.local_total_sen ?? 0),
          0,
        ),
        total_outstanding_sen: rows.reduce(
          (s, r) => s + Number(r.outstanding_sen ?? 0),
          0,
        ),
      };
    }
  }
  return c.json({ summary, snapshot: false, refreshed_at: null });
});

export default outstanding;
