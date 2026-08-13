import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission, requirePageAccess } from "../middleware/auth";
import { isSupabaseConfigured, getSupabaseService } from "../db/supabase";
import { reconcileLedger } from "../scm/lib/reconcile-ledger";

// ---------------------------------------------------------------------------
// /api/admin/health — System Health, "real data" phase 1. Gated on the
// `system_health` page (configurable per position; Owner / `*` always pass).
//
// Ported from Hookka ERP's /admin/health, trimmed to what Houzs can show
// WITHOUT Cloudflare Analytics Engine (Houzs has no AE binding). The
// latency-percentile / slow-SQL / front-end-RUM panels Hookka feeds from AE
// are deferred to a phase 2 that would stand up an AE dataset + query token.
//
// What this serves with REAL data today:
//   GET /live        — a live DB ping (the true request-path latency, so the
//                      Hyperdrive cold-start stall is visible), KV reachability,
//                      and headcount + audit counts.
//   GET /audit-feed  — recent business mutations from audit_events, plus a
//                      by-action / by-resource rollup, and a sensitive-action
//                      filter (the closest real-data stand-in for Hookka's
//                      security panel, which needs auth events Houzs doesn't
//                      capture yet).
//
// Every query is wrapped so a DB stall surfaces as { ok:false } in the JSON
// instead of throwing — the health page must stay readable even when the
// thing it monitors is unhealthy.
// ---------------------------------------------------------------------------
const app = new Hono<{ Bindings: Env }>();

// Sensitive-action matcher (SQL): security-relevant mutations worth a
// dedicated eye. Kept in one place so /live counts and /audit-feed agree.
const SENSITIVE_SQL =
  "(action LIKE 'user.disable%' OR action LIKE 'user.delete%' OR action LIKE 'user.reset_password%' OR action LIKE 'role.%' OR action LIKE 'user.totp%' OR action = 'finance.update')";

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};
function cutoffIso(range: string | undefined): string {
  const ms = RANGE_MS[range || "24h"] ?? RANGE_MS["24h"];
  return new Date(Date.now() - ms).toISOString();
}

app.get("/live", requirePageAccess("system_health"), async (c) => {
  // DB ping FIRST so it captures any cold-connection establishment cost —
  // this is the headline number the operator watches for the "Failed to
  // fetch" cold-start stall.
  const db: { ok: boolean; latency_ms: number; error?: string } = {
    ok: false,
    latency_ms: 0,
  };
  const t0 = Date.now();
  try {
    const r = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    db.ok = !!r?.ok;
    db.latency_ms = Date.now() - t0;
  } catch (e: any) {
    db.latency_ms = Date.now() - t0;
    db.error = e?.message || "DB ping failed";
  }

  // KV reachability — a cheap GET of a probe key (null is fine; we time the
  // round-trip, not the value). Optional binding, so guard it.
  const kv = { bound: !!c.env.SESSION_CACHE, ok: false, latency_ms: 0 };
  if (c.env.SESSION_CACHE) {
    const k0 = Date.now();
    try {
      await c.env.SESSION_CACHE.get("health:probe");
      kv.ok = true;
      kv.latency_ms = Date.now() - k0;
    } catch {
      kv.latency_ms = Date.now() - k0;
    }
  }

  // R2 reachability — a cheap HEAD/GET of a probe key on the SCM slip/photo
  // bucket (null object is fine; we time the round-trip). SO_ITEM_PHOTOS is the
  // always-bound SCM bucket. Without this the page shows green while R2 (slip
  // photos, SO-item photos) is unreachable.
  const r2 = { bound: !!c.env.SO_ITEM_PHOTOS, ok: false, latency_ms: 0 };
  if (c.env.SO_ITEM_PHOTOS) {
    const r0 = Date.now();
    try {
      await c.env.SO_ITEM_PHOTOS.head("health:probe");
      r2.ok = true;
      r2.latency_ms = Date.now() - r0;
    } catch {
      r2.latency_ms = Date.now() - r0;
    }
  }

  // Anthropic key presence — the SO-slip OCR /extract 503s when this secret is
  // unset (a recurring cutover gap). Presence-only; we never call the API here.
  const anthropic = { configured: !!c.env.ANTHROPIC_API_KEY };

  // SCM-route liveness — the page must not show green while the SCM stack is
  // 500ing. Probe ONE bounded SCM read straight through PostgREST (suppliers,
  // head+count, zero rows) so a scm-schema / Supabase outage surfaces here.
  const scm = { configured: isSupabaseConfigured(c.env), ok: false, latency_ms: 0, error: undefined as string | undefined };
  if (scm.configured) {
    const s0 = Date.now();
    try {
      const sb = getSupabaseService(c.env);
      const { error } = await sb.from("suppliers").select("id", { count: "exact", head: true }).limit(1);
      scm.latency_ms = Date.now() - s0;
      if (error) scm.error = error.message;
      else scm.ok = true;
    } catch (e: any) {
      scm.latency_ms = Date.now() - s0;
      scm.error = e?.message || "SCM probe failed";
    }
  }

  // Counts — reuse the (now-warm) connection. Each wrapped so one failure
  // doesn't blank the rest of the payload.
  const counts = {
    users_active: 0,
    users_invited: 0,
    users_disabled: 0,
    audit_24h: 0,
    audit_7d: 0,
    sensitive_24h: 0,
    last_event_at: null as string | null,
  };
  if (db.ok) {
    const iso24 = cutoffIso("24h");
    const iso7 = cutoffIso("7d");
    try {
      const byStatus = await c.env.DB.prepare(
        "SELECT status, COUNT(*) AS c FROM users GROUP BY status",
      ).all<{ status: string; c: number }>();
      for (const row of byStatus.results ?? []) {
        if (row.status === "active") counts.users_active = Number(row.c);
        else if (row.status === "invited") counts.users_invited = Number(row.c);
        else if (row.status === "disabled") counts.users_disabled = Number(row.c);
      }
    } catch {}
    try {
      const a24 = await c.env.DB.prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ?",
      )
        .bind(iso24)
        .first<{ c: number }>();
      counts.audit_24h = Number(a24?.c ?? 0);
      const a7 = await c.env.DB.prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ?",
      )
        .bind(iso7)
        .first<{ c: number }>();
      counts.audit_7d = Number(a7?.c ?? 0);
      const sens = await c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM audit_events WHERE created_at >= ? AND ${SENSITIVE_SQL}`,
      )
        .bind(iso24)
        .first<{ c: number }>();
      counts.sensitive_24h = Number(sens?.c ?? 0);
      const last = await c.env.DB.prepare(
        "SELECT created_at FROM audit_events ORDER BY created_at DESC LIMIT 1",
      ).first<{ created_at: string }>();
      counts.last_event_at = last?.created_at ?? null;
    } catch {}
  }

  return c.json({
    // Overall green requires DB up AND the SCM stack reachable (when configured)
    // AND R2 reachable (when bound) — so the page can't show green while SCM is
    // 500ing or slip-photo storage is down.
    ok: db.ok && (!scm.configured || scm.ok) && (!r2.bound || r2.ok),
    time: new Date().toISOString(),
    db,
    kv,
    r2,
    anthropic,
    scm,
    counts,
  });
});

app.get("/audit-feed", requirePageAccess("system_health"), async (c) => {
  const range = c.req.query("range") || "24h";
  const cutoff = cutoffIso(range);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, 200);
  const sensitiveOnly = c.req.query("sensitive") === "1";
  const filterSql = sensitiveOnly ? ` AND ${SENSITIVE_SQL}` : "";

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, created_at, actor_id, actor_email, action, entity_type, entity_id, summary
         FROM audit_events
        WHERE created_at >= ?${filterSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(cutoff, limit)
      .all();

    const byAction = await c.env.DB.prepare(
      `SELECT action, COUNT(*) AS n FROM audit_events WHERE created_at >= ?${filterSql} GROUP BY action ORDER BY n DESC LIMIT 8`,
    )
      .bind(cutoff)
      .all<{ action: string; n: number }>();

    const byResource = await c.env.DB.prepare(
      `SELECT entity_type, COUNT(*) AS n FROM audit_events WHERE created_at >= ?${filterSql} AND entity_type IS NOT NULL GROUP BY entity_type ORDER BY n DESC LIMIT 8`,
    )
      .bind(cutoff)
      .all();

    // The public.audit_events feed is blind to SCM business mutations, which
    // are written to scm.mfg_so_audit_log over PostgREST (supabase-js), not the
    // public schema. Pull recent SCM SO-audit rows too and normalize them into
    // the same shape so the operator sees ONE merged who-changed-what feed.
    // Best-effort + bounded: a Supabase stall must not blank the core feed, and
    // the sensitive-only filter intentionally hides these (no security-action
    // taxonomy here) so the sensitive view stays a pure public.audit_events cut.
    const coreRows = (rows.results ?? []) as any[];
    let scmRows: any[] = [];
    if (!sensitiveOnly && isSupabaseConfigured(c.env)) {
      try {
        const sb = getSupabaseService(c.env);
        const { data: scm } = await sb
          .from("mfg_so_audit_log")
          .select(
            "id, created_at, actor_id, actor_name_snapshot, action, so_doc_no, status_snapshot, note",
          )
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(limit);
        scmRows = ((scm as any[]) ?? []).map((r) => ({
          // Prefix the uuid so it can't collide with public.audit_events' numeric
          // ids in the frontend's row key.
          id: `scm:${r.id}`,
          created_at: r.created_at,
          actor_id: r.actor_id ?? null,
          actor_email: r.actor_name_snapshot ?? null,
          action: `scm.so.${String(r.action || "").toLowerCase()}`,
          entity_type: "sales_order",
          entity_id: r.so_doc_no ?? null,
          summary:
            r.note ||
            [r.so_doc_no, r.status_snapshot].filter(Boolean).join(" "),
        }));
      } catch {
        // Swallow — the SCM merge is additive; never fail the core feed on it.
      }
    }

    // Merge by timestamp (desc), then cap to the requested limit.
    const merged = [...coreRows, ...scmRows]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);

    return c.json({
      success: true,
      data: merged,
      summary: {
        byAction: (byAction.results ?? []).map((r: any) => ({ action: r.action, n: Number(r.n) })),
        byResource: (byResource.results ?? []).map((r: any) => ({
          resource: r.entity_type,
          n: Number(r.n),
        })),
      },
    });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || "audit-feed failed", data: [], summary: { byAction: [], byResource: [] } });
  }
});

// GET /ledger — "Inventory ledger integrity" health check. Runs the same
// read-only SCM reconcile sweep as /api/scm/inventory/reconcile and reports it
// as a single OK/WARN indicator: status "ok" (green) when 0 silent partial
// stock-writes are found, "warn" (red) with the count when any document moved
// stock on paper but has zero matching inventory_movements rows.
//
// SCM lives in the `scm` Postgres schema reached over PostgREST (supabase-js),
// separate from this route's D1/public-schema c.env.DB — so we build the
// scm-scoped service client here, the same one the SCM routes use. Read-only +
// bounded; wrapped so a Supabase stall surfaces as ok:false, never throws.
app.get("/ledger", requirePermission("*"), async (c) => {
  if (!isSupabaseConfigured(c.env)) {
    return c.json({
      check: "inventory_ledger_integrity",
      label: "Inventory ledger integrity",
      ok: false,
      status: "unknown",
      configured: false,
      issueCount: 0,
      error: "SCM Supabase not configured",
    });
  }
  try {
    const sb = getSupabaseService(c.env);
    const { asOf, issueCount, issues } = await reconcileLedger(sb);
    return c.json({
      check: "inventory_ledger_integrity",
      label: "Inventory ledger integrity",
      ok: issueCount === 0,
      status: issueCount === 0 ? "ok" : "warn",
      configured: true,
      issueCount,
      // Cap the inline list so an extreme backlog can't bloat the health JSON;
      // the operator drills into /api/scm/inventory/reconcile for the full set.
      issues: issues.slice(0, 50),
      asOf,
    });
  } catch (e: any) {
    return c.json({
      check: "inventory_ledger_integrity",
      label: "Inventory ledger integrity",
      ok: false,
      status: "unknown",
      configured: true,
      issueCount: 0,
      error: e?.message || "ledger reconcile failed",
    });
  }
});

// ── AutoCount migration reconciliation ─────────────────────────────
// The daily 02:00 cron refreshes the PO mirrors and the ac_snapshot_* staging
// tables unattended. These three routes exist because the migration cleanup is
// an interactive job: somebody is sitting there asking "is it clean yet?" and
// cannot wait until 02:00 to find out. Owner-only (`*`) — they wipe-and-reload
// mirrors Finance reads.

// One number per question, so "is the data clean yet?" stops being a matter of
// opinion. Every count is a diff between what AutoCount has and what the ERP
// has; clean = all of them zero.
//
// mirror_po_outstanding_lines is a plain COUNT(*), NOT a count of
// is_outstanding = 1. The middleware's /getOutstanding filters to
// "Qty - TransferedQty > 0", so every row in `purchase_orders` is outstanding
// by construction and the pull leaves that legacy column NULL — the predicate
// would report 0 on a perfectly good pull, which is precisely the silent zero
// this endpoint exists to stop.
//
// No "--" comments inside the SQL: d1-compat splits statements and a line
// comment swallows what follows it.
app.get("/autocount/reconcile", requirePermission("*"), async (c) => {
  try {
    const row = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM ac_snapshot_sales_orders)                       AS snapshot_so,
         (SELECT MAX(snapshot_at) FROM ac_snapshot_sales_orders)               AS snapshot_so_at,
         (SELECT COUNT(*) FROM ac_snapshot_sales_orders WHERE region_route IS NULL)
                                                                               AS snapshot_so_filtered_out,
         (SELECT COUNT(*) FROM sales_orders)                                   AS mirror_so,
         (SELECT COUNT(*) FROM scm.mfg_sales_orders)                           AS erp_so,
         (SELECT COUNT(*) FROM ac_snapshot_sales_orders a
            WHERE NOT EXISTS (SELECT 1 FROM scm.mfg_sales_orders e
                               WHERE e.linked_ac_docno = a.doc_no))            AS so_missing_from_erp,
         (SELECT COUNT(*) FROM scm.mfg_sales_orders e
            WHERE COALESCE(e.linked_ac_docno,'') <> ''
              AND NOT EXISTS (SELECT 1 FROM ac_snapshot_sales_orders a
                               WHERE a.doc_no = e.linked_ac_docno))            AS so_link_not_in_autocount,
         (SELECT COUNT(*) FROM ac_snapshot_purchase_orders)                    AS snapshot_po,
         (SELECT MAX(snapshot_at) FROM ac_snapshot_purchase_orders)            AS snapshot_po_at,
         (SELECT COUNT(*) FROM purchase_order_docs)                            AS mirror_po_docs,
         (SELECT COUNT(*) FROM purchase_orders)                                AS mirror_po_outstanding_lines,
         (SELECT COUNT(*) FROM scm.purchase_orders p
            WHERE COALESCE(p.linked_ac_docno,'') <> ''
              AND NOT EXISTS (SELECT 1 FROM ac_snapshot_purchase_orders a
                               WHERE a.doc_no = p.linked_ac_docno))            AS po_link_not_in_autocount`
    ).first<Record<string, number | string | null>>();

    const snapshotSo = Number(row?.snapshot_so ?? 0);
    return c.json({
      check: "autocount_migration_reconcile",
      label: "AutoCount migration reconciliation",
      // Without a snapshot there is no denominator, so the honest answer is
      // "unknown" — never "ok". That distinction is the entire point of this
      // endpoint: a silent zero used to read as "clean".
      status: snapshotSo === 0 ? "unknown" : "ok",
      snapshotTaken: snapshotSo > 0,
      counts: row ?? {},
    });
  } catch (e: any) {
    return c.json({
      check: "autocount_migration_reconcile",
      label: "AutoCount migration reconciliation",
      status: "unknown",
      snapshotTaken: false,
      error: e?.message || "reconcile query failed",
    });
  }
});

// Refresh both PO mirrors now. Docs first, then lines — the doc pull is what
// Finance reads, so it gets the fresher data if the second call fails.
app.post("/autocount/po-pull", requirePermission("*"), async (c) => {
  try {
    const { runPOPull, runPODocsPull } = await import("../services/po");
    const docs = await runPODocsPull(c.env, "MANUAL");
    const lines = await runPOPull(c.env, "MANUAL");
    return c.json({ docs, lines });
  } catch {
    // Plain-language rule: never surface raw exception text to the user.
    return c.json({ error: "Couldn't reach AutoCount to refresh purchase orders. Try again shortly." }, 502);
  }
});

// Rebuild the unfiltered staging snapshot. Writes only ac_snapshot_*, so this
// is the safe one to re-run whenever a fresh denominator is wanted.
app.post("/autocount/snapshot", requirePermission("*"), async (c) => {
  try {
    const { runSOSnapshot, runPOSnapshot } = await import("../services/acSnapshot");
    const so = await runSOSnapshot(c.env, "MANUAL");
    const po = await runPOSnapshot(c.env, "MANUAL");
    return c.json({ so, po });
  } catch {
    // Plain-language rule: never surface raw exception text to the user.
    return c.json({ error: "Couldn't reach AutoCount to build the snapshot. Try again shortly." }, 502);
  }
});

export default app;
