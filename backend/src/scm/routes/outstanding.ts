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
import { scopeToCompany } from "../lib/companyScope";
import { reduceAgingSnapshot, type AgingMvRow } from "../lib/ar-aging";

export const outstanding = new Hono<{ Bindings: Env; Variables: Variables }>();
outstanding.use("*", supabaseAuth);

// Map endpoint → (view, date column for from/to filter).
const MODULES: Record<string, { view: string; dateCol: string }> = {
  po:  { view: "v_po_outstanding",  dateCol: "po_date" },
  grn: { view: "v_grn_outstanding", dateCol: "received_at" },
  pi:  { view: "v_pi_outstanding",  dateCol: "invoice_date" },
  pr:  { view: "v_pr_outstanding",  dateCol: "return_date" },
  so:  { view: "v_so_outstanding",  dateCol: "so_date" },
  do:  { view: "v_do_outstanding",  dateCol: "do_date" },
  si:  { view: "v_si_outstanding",  dateCol: "invoice_date" },
};

for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
  outstanding.get(`/${slug}`, async (c) => {
    const sb = c.get("supabase");
    const outstandingParam = c.req.query("outstanding");
    const from = c.req.query("from");
    const to = c.req.query("to");

    // Page through so PostgREST's 1000-row cap can't silently truncate the
    // outstanding list (an "all"/wide-range view can exceed 1000 docs).
    const { data, error } = await paginateAll((pFrom, pTo) => {
      let q = sb.from(view).select("*").order(dateCol, { ascending: false });
      q = scopeToCompany(q, c); // multi-company: isolate to the active company (views expose company_id via mig 0062)
      // outstanding filter: default = true (only outstanding rows)
      if (outstandingParam === "true" || outstandingParam == null) {
        q = q.eq("is_outstanding", true);
      } else if (outstandingParam === "false") {
        q = q.eq("is_outstanding", false);
      }
      // else 'all' (or any other value) → no filter, return both
      /* LEAK GUARD (DRAFT) — a DRAFT Sales Invoice has not posted AR yet, so it
         must never appear in the SI Outstanding / AR-aging list. The
         v_si_outstanding view's is_outstanding CASE only excludes PAID/CANCELLED
         (it would mark a DRAFT outstanding), so filter DRAFT out here. The view
         exposes s.status, so this is safe (verified 0059_outstanding_views.sql). */
      if (slug === "si") q = q.neq("status", "DRAFT");
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, to);
      return q.range(pFrom, pTo);
    });
    if (error) {
      // The view is missing entirely → treat as "no data yet" so the page
      // renders an empty tab instead of 500ing.
      if (/relation .* does not exist/i.test(error.message)) {
        return c.json({ rows: [] });
      }
      return c.json({ error: "load_failed", reason: error.message }, 500);
    }
    return c.json({ rows: data ?? [] });
  });
}

/* Per-module aggregate shape for /summary. The JS reducer this replaces sums
   `Number(r.total_centi ?? r.local_total_centi ?? 0)` and
   `Number(r.outstanding_centi ?? 0)` over every outstanding row. Cross-referenced
   against the v_*_outstanding view definitions (mig 0084), each view exposes at
   most ONE of {total_centi, local_total_centi} and only pi/si expose
   outstanding_centi — so no view ever mixes columns in the `??` chain and each
   module maps to a single SUM column (or none → the total is always 0). We push
   these sums into SQL via PostgREST aggregates:
     - pkCol:   a non-null PK → PK.count() equals rows.length exactly.
     - amtCol:  the column the `total_centi` reduce resolves to for this view
                (null ⇒ total_centi is always 0, so no sum is requested).
     - outCol:  outstanding_centi where the view has it (null ⇒ always 0).
   SUM ignores NULLs (0 contribution) exactly as the `?? 0` chain does, so the
   numbers stay byte-identical. */
const SUMMARY_AGG: Record<
  string,
  { pkCol: string; amtCol: string | null; outCol: string | null }
> = {
  po:  { pkCol: "id",     amtCol: "total_centi",       outCol: null },
  grn: { pkCol: "id",     amtCol: null,                outCol: null },
  pi:  { pkCol: "id",     amtCol: "total_centi",       outCol: "outstanding_centi" },
  pr:  { pkCol: "id",     amtCol: null,                outCol: null },
  so:  { pkCol: "doc_no", amtCol: "local_total_centi", outCol: null },
  do:  { pkCol: "id",     amtCol: null,                outCol: null },
  si:  { pkCol: "id",     amtCol: "total_centi",       outCol: "outstanding_centi" },
};

/* /outstanding/summary — counts + totals across all modules in one call.
   Used by the cross-module Outstanding Dashboard. Degrades to a zeroed summary
   when a view is missing/empty.

   Aggregates in SQL (one PostgREST aggregate request per module) instead of
   fetching every outstanding row and reducing in JS. Output numbers are
   byte-identical to the old reducer (see SUMMARY_AGG). If the aggregate request
   errors for any reason (aggregates disabled, missing view, etc.) that module
   falls back to the original paginate-all + JS reduce so a total is never
   wrong — worst case it's as slow as before, never incorrect. */
outstanding.get("/summary", async (c) => {
  const sb = c.get("supabase");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const wantSnapshot = c.req.query("snapshot") === "1";

  /* SNAPSHOT FAST PATH (?snapshot=1) — serve the pre-aggregated scm.mv_ar_aging
     (migration 0151) instead of the seven live SUM/count scans. The live query
     stays the DEFAULT: the Outstanding page is a same-day operational dashboard
     and always sends a user-chosen date range (Outstanding.tsx), which this
     all-time snapshot does not carry — so the snapshot is opt-in for callers who
     want the cheap all-time rollup and accept a nightly figure.

     Only honoured with NO date range: the MV is all-time, so a date-bounded
     request MUST fall through to the live path (which filters each module by its
     own date column). A missing MV / freshness row — migration 0151 not yet
     applied on this DB — also falls through, so the endpoint degrades to exactly
     the behaviour it has today. */
  if (wantSnapshot && !from && !to) {
    const meta = await sb
      .from("mv_ar_aging_meta")
      .select("refreshed_at")
      .limit(1)
      .maybeSingle();
    if (!meta.error) {
      let mvQ = sb
        .from("mv_ar_aging")
        .select("module, cnt, total_centi, total_outstanding_centi");
      mvQ = scopeToCompany(mvQ, c); // same REQUIRED-half predicate as the live path
      const { data, error } = await mvQ;
      if (!error) {
        return c.json({
          summary: reduceAgingSnapshot((data ?? []) as AgingMvRow[]),
          snapshot: true,
          refreshed_at: (meta.data?.refreshed_at as string | null) ?? null,
        });
      }
    }
    // fall through to the live computation below
  }

  const summary: Record<
    string,
    { count: number; total_centi?: number; total_outstanding_centi?: number }
  > = {};

  // Shared filter set — IDENTICAL to the individual endpoints' outstanding path:
  // is_outstanding=true + company scope + SI DRAFT leak-guard + optional date range.
  // Typed loosely (any) on purpose: the dynamic aggregate `.select("cnt:...")`
  // string defeats supabase-js's static column-type inference, so we chain the
  // PostgREST filter methods structurally without dragging in the builder's type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFilters = (q0: any, slug: string, dateCol: string): any => {
    let q = q0.eq("is_outstanding", true);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    // LEAK GUARD (DRAFT) — keep DRAFT SIs out of the AR outstanding totals.
    if (slug === "si") q = q.neq("status", "DRAFT");
    if (from) q = q.gte(dateCol, from);
    if (to) q = q.lte(dateCol, to);
    return q;
  };

  for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
    const agg = SUMMARY_AGG[slug];
    let done = false;

    if (agg) {
      // PostgREST aggregate: PK.count() = row count, plus the module's SUM
      // column(s). All aggregates → a single implicit group → one returned row.
      const parts = [`cnt:${agg.pkCol}.count()`];
      if (agg.amtCol) parts.push(`amt:${agg.amtCol}.sum()`);
      if (agg.outCol) parts.push(`outs:${agg.outCol}.sum()`);
      const { data, error } = await applyFilters(
        sb.from(view).select(parts.join(",")),
        slug,
        dateCol,
      );
      if (!error) {
        const row = ((data ?? []) as Array<Record<string, unknown>>)[0] ?? {};
        summary[slug] = {
          count: Number(row.cnt ?? 0),
          // SUM over zero rows is NULL → coalesce to 0, matching the empty reduce.
          total_centi: agg.amtCol ? Number(row.amt ?? 0) : 0,
          total_outstanding_centi: agg.outCol ? Number(row.outs ?? 0) : 0,
        };
        done = true;
      }
    }

    if (!done) {
      // Fallback — original paginate-all + JS reduce. Preserves exact numbers and
      // the missing-view graceful degradation (error → data null → zeroed module).
      const { data } = await paginateAll((pFrom, pTo) =>
        applyFilters(sb.from(view).select("*"), slug, dateCol).range(pFrom, pTo),
      );
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      summary[slug] = {
        count: rows.length,
        total_centi: rows.reduce(
          (s, r) => s + Number(r.total_centi ?? r.local_total_centi ?? 0),
          0,
        ),
        total_outstanding_centi: rows.reduce(
          (s, r) => s + Number(r.outstanding_centi ?? 0),
          0,
        ),
      };
    }
  }
  // Live path: numbers are computed on this request, so `refreshed_at` is null
  // (no snapshot) and `snapshot` is false — Finance can tell a live figure from
  // a nightly one by these two fields.
  return c.json({ summary, snapshot: false, refreshed_at: null });
});

export default outstanding;
