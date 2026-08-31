import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission, requirePageAccess } from "../middleware/auth";
import { isSupabaseConfigured, getSupabaseService } from "../db/supabase";
import { reconcileLedger } from "../scm/lib/reconcile-ledger";
import { PAGE as PAGINATE_ALL_PAGE } from "../scm/lib/paginate-all";
import { sessionSigningSecret } from "../services/session-pass";

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

  // Signed sessions — the ONE secret that decides whether every API request pays
  // for two joined authorization reads. Unset, `tryPassAuth` is a no-op and
  // `getUserBySession` runs a six-table join plus a four-branch UNION on the
  // shared connection pool BEFORE any route body, which is what makes cheap
  // endpoints (/api/presence, /api/branding) take about a second under load.
  //
  // PRESENCE ONLY, and computed through `sessionSigningSecret` rather than a
  // truthiness test on the raw secret: that helper also rejects a key under 16
  // characters, so a placeholder reads as OFF here exactly as it behaves at
  // runtime. The value itself never leaves the worker.
  const sessionSigning = { configured: sessionSigningSecret(c.env) !== null };

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
    sessionSigning,
    scm,
    counts,
  });
});


// ---------------------------------------------------------------------------
// GET /rest-page-ceiling — HOW MANY ROWS DOES THE POSTGREST EDGE ACTUALLY HAND
// BACK? Read-only: every call below is a GET of ONE narrow column, and the
// response carries counts only — never a row, a doc_no or a name.
//
// WHY THIS LIVES IN THE WORKER AND NOT IN A SCRIPT. The number is a property of
// the REST edge, and only the Worker can ask it: `db/supabase.ts:66` builds the
// real `createClient(url, serviceKey)` and every `sb.from(...)` in the SCM
// module is a PostgREST call, but those two credentials exist ONLY as Worker
// secrets. They are deliberately NOT GitHub secrets (public repo, readable by
// non-admin collaborators, and the service-role key bypasses RLS on a database
// two tenants share), so `probe-mrp-read-ceiling.mjs`'s REST half could never
// run from Actions — runs 31941352447 and 31942066593 both printed
// "SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set". Rewriting it
// over DATABASE_URL would have measured Postgres, which is not the thing in
// question. So it is asked from the process that already holds the credentials
// and already issues the exact request.
//
// WHAT IT SETTLES. `lib/paginate-all.ts`'s header asserts a 1000-row cap; that
// assertion was never measured, and 52 files page against `PAGE`. Two failures
// are possible and this separates them:
//   · ceiling >= PAGE — paginateAll's short-page stop is sound.
//   · ceiling <  PAGE — page one comes back short, the loop stops on it, and
//     EVERY paged read in the tree truncates silently.
// It imports the real `PAGE` rather than restating 1000, so the verdict cannot
// agree with itself by construction.
//
// HOW TO READ IT. `returned` vs `contentRangeTotal` is the whole answer: the
// total is what the filter matches, `returned` is what arrived. A gap is rows
// dropped with no error. A probe is only informative when the table holds MORE
// rows than were requested — otherwise the read ran out of table, not out of
// ceiling, and it is reported `inconclusive` rather than counted as evidence.
// ---------------------------------------------------------------------------

/* CANDIDATE TABLES, probed head-only first so the ladder runs against whichever
   actually holds enough rows to be informative. A fixed table cannot do that
   job across environments: production's `mfg_sales_order_items` carries ~13.9k
   rows, but on staging that same table holds 67 (run 32281490702) while
   `mfg_products` holds 1,326 — so a hardcoded target answers on one stack and
   returns "inconclusive" on the other. All are SCM master/among-largest tables
   and all are read as `select=id` alone. This is a fixed allow-list, never a
   caller-supplied table name: the gate is `*`, but a table name off the wire
   would still be an arbitrary-read primitive. */
const CEILING_CANDIDATES = [
  "mfg_sales_order_items",
  "mfg_products",
  "mfg_sales_orders",
  "purchase_order_items",
] as const;
/* Straddles the asserted 1000 on both sides so the ceiling is LOCATED rather
   than assumed. PAGE+1 is the one that matters: at exactly PAGE, a cap and a
   table that happens to stop there are indistinguishable. */
const CEILING_LIMITS = [500, 1000, 1001, 5000] as const;

/** Error text without an `any`: a thrown value is `unknown` until proven. */
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

  /* STEP 1 — size the candidates, head-only (`head: true` sends the count
     request and returns ZERO rows), then probe the biggest. A ladder is only
     evidence about a ceiling when the table can outrun the limit being asked
     for, so the target is chosen by measurement rather than assumed. */
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
      /* "The table ran out" and "the edge capped" are the same observation
         unless the total exceeds what was asked for. Only the latter is
         evidence about a ceiling. */
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

  /* paginateAll's FIRST WINDOW, issued in its own shape rather than inferred
     from the `.limit()` probes above. `.range(a,b)` is a Range header, not a
     `limit=` parameter, and the second-order question is specifically about
     what THIS call returns — so it is measured, not reasoned about. */
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

  /* THE CEILING. The most rows the edge was ever willing to hand back — taken
     from the probes that actually pushed past the table's own size, because a
     read that ran out of rows says nothing about a cap. `null` when no probe
     was conclusive, and that is reported as UNKNOWN rather than smoothed into
     a number. */
  const conclusive = probes.filter((p) => p.inconclusive === false && p.returned != null);
  const ceiling = conclusive.length
    ? Math.max(...conclusive.map((p) => p.returned as number))
    : null;

  /* THE SECOND-ORDER VERDICT. paginateAll stops on the first page shorter than
     PAGE, so a ceiling BELOW PAGE makes page one look final. Decided from the
     measured first window where that is conclusive — the direct observation —
     and from `ceiling` otherwise. */
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

  /* DOES THE CAP GENERALISE? PostgREST's row cap is server configuration
     (`db-max-rows`), not a per-table property — but that is a claim about how
     PostgREST is built, and this endpoint exists because claims of that shape
     went unchecked for weeks. So ask the SAME decisive limit (PAGE+1) of every
     OTHER candidate big enough to answer, and let the payload show whether the
     number repeats across tables instead of asserting that it must. */
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
    /* WHAT THIS MEASUREMENT CANNOT SEE. Stated in the payload, not just in a
       comment, because the number gets quoted and the caveats get dropped. */
    scopeNotes: [
      `The ladder is direct evidence about ONE table (${CEILING_TABLE}, chosen as the largest countable candidate) read as a single narrow column through getSupabaseService — the same client the SCM module uses.`,
      `Generalisation is measured, not asserted: \`crossTable\` re-asks the decisive ${PAGINATE_ALL_PAGE + 1} of every other candidate holding more than ${PAGINATE_ALL_PAGE} rows. ${crossTable.length} such table(s) were available here. PostgREST's cap is server-level \`db-max-rows\` rather than per-table, so agreement across tables is expected — but where crossTable is empty, only the one table is actually evidenced.`,
      "A probe whose contentRangeTotal is <= its requested limit is marked inconclusive: the read ran out of rows, not out of ceiling, so it is not counted toward `ceiling`.",
      "This measures a ROW cap only. A wide select, an embedded resource, or a large payload can fail on response size or URI length instead — different limits, not measured here (see lib/paginate-all.ts's URL_QUERY_BUDGET for the URI one).",
    ],
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
    /* null = ALL COMPANIES, on purpose. This is the cross-company integrity
       count; the per-company report is the operator-facing /reconcile route.
       Written out rather than omitted so the two modes are distinguishable at
       the call site — an omitted argument reads the same whether the author
       meant "every company" or never knew there was a choice. */
    const { asOf, issueCount, issues } = await reconcileLedger(sb, null);
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

/* Refresh the SALES-ORDER mirror. The PO twin above has existed for a while; this
   one did not, and its absence is why a stale mirror could only be fixed by
   waiting.

   `?mode=all` is the point. The incremental path asks AutoCount getSince(
   pull_checkpoint), so an order whose LAST MODIFIED date precedes the mirror's
   earliest checkpoint is never offered and never arrives — no amount of waiting
   collects it. `all` goes through getAll and, per services/pull.ts:29, does NOT
   touch the checkpoint, so a backfill cannot disturb the incremental pull that
   is working. Default stays `filtered` so a mis-click is the cheap one.

   Proved necessary 2026-08-19: SO-005263 exists in AutoCount, a salesperson
   could not raise a Service Case against it, and the mirror held 3281 rows with
   no trace of that number or its digits while the checkpoint was CURRENT.

   Idempotent: the INSERT is ON CONFLICT(doc_no) DO UPDATE, so re-running
   refreshes rows rather than duplicating them. */
app.post("/autocount/so-pull", requirePermission("*"), async (c) => {
  const mode = c.req.query("mode") === "all" ? "all" : "filtered";
  /* `?since=YYYY-MM-DD` is the BACKFILL, and it is the one that works. `mode=all`
     calls getAll() and against ~13,000 orders it killed the Worker outright —
     measured 2026-08-19: 39 seconds, then `Worker exceeded resource limits`. So a
     backlog is collected in WINDOWS, and `since` neither reads nor advances the
     checkpoint, which is what makes it safe to run beside the live pull. */
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
