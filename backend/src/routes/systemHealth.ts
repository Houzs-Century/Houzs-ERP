import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission, requireItPages } from "../middleware/auth";
import { isSupabaseConfigured, getSupabaseService } from "../db/supabase";
import { reconcileLedger } from "../scm/lib/reconcile-ledger";
import { PAGE as PAGINATE_ALL_PAGE } from "../scm/lib/paginate-all";
import { sessionSigningSecret } from "../services/session-pass";
import {
  cacheFamilyReading, readingFor, CLIENT_POLL_SECONDS, type AuthFastPath,
} from "../services/auth-fastpath-probe";
import {
  CONFIG_CACHE_TTL_SECONDS, configCacheKeyUrl, configCacheMatch,
} from "../services/configCache";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import { acServiceConfig, callAcService } from "../services/autocount-writeback";
import systemHealthLogins from "./systemHealthLogins";
import systemHealthServices from "./systemHealthServices";
import systemHealthDatabase from "./systemHealthDatabase";
import systemHealthJobs from "./systemHealthJobs";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireItPages());
app.route("/", systemHealthLogins);
app.route("/", systemHealthServices);
app.route("/", systemHealthDatabase);
app.route("/", systemHealthJobs);

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

app.get("/live", async (c) => {
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

  const anthropic = { configured: !!c.env.ANTHROPIC_API_KEY };

  const sessionSigningConfigured = sessionSigningSecret(c.env) !== null;
  const thisRequestPath: AuthFastPath = c.get("authPath") ?? "unknown";
  const sessionSigning = { configured: sessionSigningConfigured };
  const clientSentPass = (c.req.header("X-Session-Pass") || "").length > 0;

  const presenceScopeKey = (() => {
    const cos = allowedCompanyIds(c);
    return cos === undefined
      ? "scope=all"
      : `scope=co:${[...cos].sort((a, b) => a - b).join(",")}`;
  })();
  const presenceKeyUrl = configCacheKeyUrl(
    new URL(c.req.url).origin, "presence", presenceScopeKey, 1,
  );
  let presenceState: "hit" | "miss" | "bypass" = "bypass";
  if (presenceKeyUrl) {
    presenceState = (await configCacheMatch(presenceKeyUrl)) ? "hit" : "miss";
  }
  const configCache = {
    presence: cacheFamilyReading(
      CONFIG_CACHE_TTL_SECONDS.presence, CLIENT_POLL_SECONDS.presence, presenceState,
    ),
    banner: cacheFamilyReading(
      CONFIG_CACHE_TTL_SECONDS.banner, CLIENT_POLL_SECONDS.banner, "bypass",
    ),
  };
  const authFastPath = {
    session_pass: { ...sessionSigning, this_request: thisRequestPath, client_sent_pass: clientSentPass },
    config_cache: configCache,
    reading: readingFor(sessionSigningConfigured, thisRequestPath, configCache, clientSentPass),
  };

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
    ok: db.ok && (!scm.configured || scm.ok) && (!r2.bound || r2.ok),
    time: new Date().toISOString(),
    db,
    kv,
    r2,
    anthropic,
    sessionSigning,
    authFastPath,
    scm,
    counts,
  });
});



const CEILING_CANDIDATES = [
  "mfg_sales_order_items",
  "mfg_products",
  "mfg_sales_orders",
  "purchase_order_items",
] as const;
const CEILING_LIMITS = [500, 1000, 1001, 5000] as const;

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

type CeilingProbe = {
  requested: number;
  returned: number | null;
  contentRangeTotal: number | null;
  short: boolean | null;
  cappedByEdge: boolean | null;
  inconclusive: boolean | null;
  error?: string;
};

app.get("/rest-page-ceiling", requirePermission("*"), async (c) => {
  if (!isSupabaseConfigured(c.env)) {
    return c.json(
      {
        check: "rest_page_ceiling",
        status: "unknown",
        error: "Supabase REST is not configured on this Worker — nothing to measure.",
      },
      503,
    );
  }

  const sb = getSupabaseService(c.env);
  const probes: CeilingProbe[] = [];

  const sizes: { table: string; total: number | null; error?: string }[] = [];
  for (const table of CEILING_CANDIDATES) {
    try {
      const { count, error } = await sb.from(table).select("id", { count: "exact", head: true });
      sizes.push({ table, total: typeof count === "number" ? count : null, error: error?.message });
    } catch (e: unknown) {
      sizes.push({ table, total: null, error: errText(e, "count failed") });
    }
  }
  const countable = sizes
    .filter((x) => typeof x.total === "number")
    .sort((a, b) => (b.total as number) - (a.total as number));
  if (countable.length === 0) {
    return c.json({
      check: "rest_page_ceiling",
      status: "unknown",
      error: "no candidate table could be counted — cannot measure a ceiling",
      tableSizes: sizes,
    }, 200);
  }
  const CEILING_TABLE = countable[0].table;

  for (const requested of CEILING_LIMITS) {
    const t0 = Date.now();
    try {
      const { data, count, error } = await sb
        .from(CEILING_TABLE)
        .select("id", { count: "exact" })
        .limit(requested);
      if (error) {
        probes.push({
          requested, returned: null, contentRangeTotal: null,
          short: null, cappedByEdge: null, inconclusive: null,
          error: error.message,
        });
        continue;
      }
      const returned = data.length;
      const total = typeof count === "number" ? count : null;
      const inconclusive = total == null ? true : total <= requested;
      probes.push({
        requested,
        returned,
        contentRangeTotal: total,
        short: returned < requested,
        cappedByEdge: inconclusive ? null : returned < requested,
        inconclusive,
      });
    } catch (e: unknown) {
      probes.push({
        requested, returned: null, contentRangeTotal: null,
        short: null, cappedByEdge: null, inconclusive: null,
        error: `${errText(e, "probe failed")} (after ${Date.now() - t0}ms)`,
      });
    }
  }

  let firstWindow: CeilingProbe = {
    requested: PAGINATE_ALL_PAGE, returned: null, contentRangeTotal: null,
    short: null, cappedByEdge: null, inconclusive: null,
  };
  try {
    const { data, count, error } = await sb
      .from(CEILING_TABLE)
      .select("id", { count: "exact" })
      .range(0, PAGINATE_ALL_PAGE - 1);
    if (error) firstWindow.error = error.message;
    else {
      const returned = data.length;
      const total = typeof count === "number" ? count : null;
      const inconclusive = total == null ? true : total <= PAGINATE_ALL_PAGE;
      firstWindow = {
        requested: PAGINATE_ALL_PAGE,
        returned,
        contentRangeTotal: total,
        short: returned < PAGINATE_ALL_PAGE,
        cappedByEdge: inconclusive ? null : returned < PAGINATE_ALL_PAGE,
        inconclusive,
      };
    }
  } catch (e: unknown) {
    firstWindow.error = errText(e, "range probe failed");
  }

  const conclusive = probes.filter((p) => p.inconclusive === false && p.returned != null);
  const ceiling = conclusive.length
    ? Math.max(...conclusive.map((p) => p.returned as number))
    : null;

  let paginateAll: { page: number; verdict: string; basis: string };
  if (firstWindow.inconclusive === false && firstWindow.returned != null) {
    paginateAll = {
      page: PAGINATE_ALL_PAGE,
      verdict: firstWindow.returned >= PAGINATE_ALL_PAGE ? "CORRECT" : "TRUNCATES_SILENTLY",
      basis:
        `measured directly: its own .range(0, ${PAGINATE_ALL_PAGE - 1}) window returned ` +
        `${firstWindow.returned} of ${firstWindow.contentRangeTotal} matching rows`,
    };
  } else if (ceiling != null) {
    paginateAll = {
      page: PAGINATE_ALL_PAGE,
      verdict: ceiling >= PAGINATE_ALL_PAGE ? "CORRECT" : "TRUNCATES_SILENTLY",
      basis: `inferred from the measured ceiling ${ceiling} (the .range() probe was inconclusive)`,
    };
  } else {
    paginateAll = {
      page: PAGINATE_ALL_PAGE,
      verdict: "UNKNOWN",
      basis: "no probe was conclusive — see scopeNotes",
    };
  }

  const crossTable: CeilingProbe[] = [];
  for (const s2 of sizes) {
    if (s2.table === CEILING_TABLE) continue;
    if (typeof s2.total !== "number" || s2.total <= PAGINATE_ALL_PAGE) continue;
    const requested = PAGINATE_ALL_PAGE + 1;
    try {
      const { data, count, error } = await sb
        .from(s2.table)
        .select("id", { count: "exact" })
        .limit(requested);
      if (error) {
        crossTable.push({ requested, returned: null, contentRangeTotal: null, short: null, cappedByEdge: null, inconclusive: null, error: `${s2.table}: ${error.message}` });
        continue;
      }
      const returned = data.length;
      const total = typeof count === "number" ? count : null;
      const inconclusive = total == null ? true : total <= requested;
      crossTable.push({
        requested, returned, contentRangeTotal: total,
        short: returned < requested,
        cappedByEdge: inconclusive ? null : returned < requested,
        inconclusive,
        error: undefined,
      });
    } catch (e: unknown) {
      crossTable.push({ requested, returned: null, contentRangeTotal: null, short: null, cappedByEdge: null, inconclusive: null, error: `${s2.table}: ${errText(e, "probe failed")}` });
    }
  }

  return c.json({
    check: "rest_page_ceiling",
    label: "PostgREST page ceiling, measured at the edge",
    time: new Date().toISOString(),
    status: ceiling == null ? "unknown" : "ok",
    table: CEILING_TABLE,
    tableSizes: sizes,
    ceiling,
    probes,
    crossTable,
    paginateAllFirstWindow: firstWindow,
    paginateAll,
    scopeNotes: [
      `The ladder is direct evidence about ONE table (${CEILING_TABLE}, chosen as the largest countable candidate) read as a single narrow column through getSupabaseService — the same client the SCM module uses.`,
      `Generalisation is measured, not asserted: \`crossTable\` re-asks the decisive ${PAGINATE_ALL_PAGE + 1} of every other candidate holding more than ${PAGINATE_ALL_PAGE} rows. ${crossTable.length} such table(s) were available here. PostgREST's cap is server-level \`db-max-rows\` rather than per-table, so agreement across tables is expected — but where crossTable is empty, only the one table is actually evidenced.`,
      "A probe whose contentRangeTotal is <= its requested limit is marked inconclusive: the read ran out of rows, not out of ceiling, so it is not counted toward `ceiling`.",
      "This measures a ROW cap only. A wide select, an embedded resource, or a large payload can fail on response size or URI length instead — different limits, not measured here (see lib/paginate-all.ts's URL_QUERY_BUDGET for the URI one).",
    ],
  });
});

app.get("/audit-feed", async (c) => {
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
      }
    }

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
    const { asOf, issueCount, issues } = await reconcileLedger(sb, null);
    return c.json({
      check: "inventory_ledger_integrity",
      label: "Inventory ledger integrity",
      ok: issueCount === 0,
      status: issueCount === 0 ? "ok" : "warn",
      configured: true,
      issueCount,
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


app.get("/autocount/reconcile", requirePermission("*"), async (c) => {
  // company-scope: owner-only (`*`) whole-system reconciliation. It returns COUNTs only, no row and no id, and compares the AutoCount snapshot against every mirror; a company predicate would make the diff wrong, not safer.
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

app.post("/autocount/po-pull", requirePermission("*"), async (c) => {
  try {
    const { runPOPull, runPODocsPull } = await import("../services/po");
    const docs = await runPODocsPull(c.env, "MANUAL");
    const lines = await runPOPull(c.env, "MANUAL");
    return c.json({ docs, lines });
  } catch {
    return c.json({ error: "Couldn't reach AutoCount to refresh purchase orders. Try again shortly." }, 502);
  }
});

app.post("/autocount/so-pull", requirePermission("*"), async (c) => {
  const mode = c.req.query("mode") === "all" ? "all" : "filtered";
  const sinceRaw = (c.req.query("since") ?? "").trim();
  if (sinceRaw && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(sinceRaw)) {
    return c.json({ error: "since must look like 2026-01-31 or 2026-01-31 00:00:00" }, 400);
  }
  const since = sinceRaw || null;
  try {
    const { runPull } = await import("../services/pull");
    const result = await runPull(c.env, "MANUAL", mode, since);
    return c.json({ mode, since, result });
  } catch {
    return c.json({ error: "Couldn't reach AutoCount to refresh sales orders. Try again shortly." }, 502);
  }
});

app.post("/autocount/snapshot", requirePermission("*"), async (c) => {
  try {
    const { runSOSnapshot, runPOSnapshot } = await import("../services/acSnapshot");
    const so = await runSOSnapshot(c.env, "MANUAL");
    const po = await runPOSnapshot(c.env, "MANUAL");
    return c.json({ so, po });
  } catch {
    return c.json({ error: "Couldn't reach AutoCount to build the snapshot. Try again shortly." }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /autocount/host-build — WHICH BUILD OF AcSyncService IS THE OFFICE HOST
// ACTUALLY RUNNING? Read-only: one proxied GET of the service's own /health,
// and the response carries the build identity plus a verdict — never a URL,
// never a key, never a document.
//
// WHY THIS LIVES IN THE WORKER AND NOT IN A SCRIPT. Same reason as
// /rest-page-ceiling one screen up, with a second reason on top. The
// credentials first: `AC_SYNC_URL` + `AC_SYNC_KEY` are WORKER secrets and are
// deliberately not GitHub ones, so a workflow cannot ask the host at all. And
// the transport: AcSyncService binds `http://localhost:<port>/` on the office
// machine (`AcSyncService.cs`, port from `C:\Temp\ac-svc-port.txt`), so an
// IP-addressed request over ZeroTier is answered by http.sys before the handler
// ever sees it. The Worker reaches it through the tunnel, so the Worker is the
// only thing in this system that can ask the question.
//
// WHAT IT SETTLES. A change to `AcSyncService.cs` ships INERT: the exe is
// rebuilt on the host by `deploy-on-host.ps1`, not by our deploy, so until
// somebody walks to that machine our half of a change is merged and doing
// nothing. `builtAt` (the assembly's own file timestamp) and `mvid` (the module
// version id, which is unique per COMPILATION) are the only things that say
// which bytes are answering. Compare `builtAt` against the last commit that
// touched the C#:
//
//   git log -1 --format=%ad --date=short -- backend/scripts/autocount-service/AcSyncService.cs
//
// builtAt earlier than that date means the host is behind, full stop. That
// command is not run here on purpose — a date compiled into the Worker would be
// a hand-maintained fact with an expiry date, which is the thing this endpoint
// exists to replace.
//
// FOUR FAILURES THAT LOOK ALIKE AND ARE NOT. The host's key check is fail-CLOSED
// and sits ABOVE its /health branch, so "the host has no key file" (503),
// "the host rejected OUR key" (401), "the tunnel answered for a stopped
// service" (a gateway status with no JSON body) and "nothing answered at all"
// are four different jobs for whoever reads this. Collapsing them into one
// "AutoCount is down" is the exact mistake #2686 cost a day to: a Cloudflare
// `error code: 502` was reported as AutoCount refusing a document.
// ---------------------------------------------------------------------------

export function stripUrls(s: string): string {
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address removed]");
}

type HostBuildVerdict =
  | "REPORTED"
  | "BUILD_UNREADABLE"
  | "BUILD_NOT_REPORTED"
  | "HOST_REFUSED_OUR_KEY"
  | "HOST_HAS_NO_KEY"
  | "HOST_DID_NOT_ANSWER"
  | "HOST_ERROR";

const HOST_BUILD_MEANING: Record<HostBuildVerdict, string> = {
  REPORTED:
    "The office AutoCount machine answered and named the build it is running. Compare builtAt against the date of the last change to the service.",
  BUILD_UNREADABLE:
    "The machine answered and it IS a build that reports its identity, but it could not read its own file — so which build is running stays unknown.",
  BUILD_NOT_REPORTED:
    "The machine answered but sent no build identity at all, which only an exe built before 2026-08-15 does. It is behind and needs rebuilding on the host.",
  HOST_REFUSED_OUR_KEY:
    "The machine is running and refused us: the key on the host and the key in this Worker are not the same. Nothing is wrong with AutoCount itself.",
  HOST_HAS_NO_KEY:
    "The machine is running but has no key file, so it is refusing every request including ours. Somebody removed or never wrote C:\\Temp\\ac-svc-key.txt.",
  HOST_DID_NOT_ANSWER:
    "Nothing reached the machine — the tunnel answered instead. The sync service is not running on that machine, or the machine is off.",
  HOST_ERROR:
    "The machine answered with an error of its own. Read hostError for its words.",
};

app.get("/autocount/host-build", requirePermission("*"), async (c) => {
  const label = "AcSyncService build running on the AutoCount host";
  if (!acServiceConfig(c.env)) {
    return c.json(
      {
        check: "autocount_host_build",
        label,
        time: new Date().toISOString(),
        status: "unknown",
        configured: false,
        verdict: "NOT_CONFIGURED",
        error:
          "AC_SYNC_URL is not set on this Worker, so there is no AutoCount host to ask. "
          + "Nothing about the office machine can be concluded from this.",
      },
      503,
    );
  }

  const t0 = Date.now();
  const res = await callAcService(c.env, "health", {});
  const latencyMs = Date.now() - t0;

  const body: Record<string, unknown> = res.body ?? {};
  const sent = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const text = (k: string): string | null => {
    const v = body[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const builtAt = text("builtAt");
  const mvid = text("mvid");

  let verdict: HostBuildVerdict;
  if (res.ok) {
    if (!sent("builtAt") && !sent("mvid")) verdict = "BUILD_NOT_REPORTED";
    else if (builtAt == null && mvid == null) verdict = "BUILD_UNREADABLE";
    else verdict = "REPORTED";
  } else if (res.status === 401) {
    verdict = "HOST_REFUSED_OUR_KEY";
  } else if (res.status === 503 && sent("error")) {
    verdict = "HOST_HAS_NO_KEY";
  } else if (res.status === 0 || ((res.status === 502 || res.status === 503 || res.status === 504) && !sent("error"))) {
    verdict = "HOST_DID_NOT_ANSWER";
  } else {
    verdict = "HOST_ERROR";
  }

  return c.json({
    check: "autocount_host_build",
    label,
    time: new Date().toISOString(),
    status: verdict === "REPORTED" ? "ok" : "unknown",
    configured: true,
    verdict,
    meaning: HOST_BUILD_MEANING[verdict],
    hostStatus: res.status,
    latencyMs,
    builtAt,
    mvid,
    book: text("book"),
    service: text("service"),
    otherKeys: Object.keys(body).filter(
      (k) => !["ok", "book", "service", "builtAt", "mvid", "error"].includes(k),
    ),
    hostError: res.error ? stripUrls(res.error) : null,
    howToCompare:
      "builtAt is the exe's file timestamp on the host. Run "
      + "`git log -1 --format=%ad --date=short -- backend/scripts/autocount-service/AcSyncService.cs`; "
      + "a builtAt earlier than that date means the host has not been rebuilt since the last change "
      + "and every change in between is inert. mvid changes on every recompile, so two readings with "
      + "the same mvid are the same bytes.",
    scopeNotes: [
      "This reports the build ANSWERING RIGHT NOW. It says nothing about whether that build is the one this repo's main branch contains — only the builtAt comparison above does that, and it is done by the reader.",
      "A rebuild is done on the office machine by deploy-on-host.ps1; our deploy cannot do it, because the SQL credentials live there and are compiled into the exe.",
      "Read-only. This route sends no document, queues nothing and writes nothing — it proxies the service's /health and reports it.",
    ],
  });
});

export default app;
