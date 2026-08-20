// Force hosted Supabase PostgREST to refresh after the 2026-08-18 money-rename
// batch (0305) DROP/CREATE'd 11 views + a matview and left the Sales Orders list
// empty for HOUZS (2,726 orders) — a live 500 "Requested range not satisfiable".
//
// WHY THIS EXISTS. The app reads the SO list through HOSTED PostgREST
// (getSupabaseService), not direct pg. Proven with check-so-list-empty.mjs:
// direct pg returns 2726 for company_id=1 through the recreated view, but the app
// (PostgREST) returns count 0. PostgREST's `pgrst_ddl_watch` trigger is enabled
// and fired at 0305's commit, so its schema MODEL reloaded — yet PostgREST's
// authenticator connection pool is 44 days old (oldest backend_start 2026-07-05,
// long before 0305 at 16:27:59Z), so it kept serving the recreated views from
// stale state a model-reload does not clear.
//
// WHAT IT DOES.
//   MODE=plan (default)  — prints the current PostgREST connections and what an
//                          apply WOULD do. No writes, no signals. Safe to run.
//   MODE=apply + CONFIRM=RELOAD-PGRST
//                        — NOTIFY pgrst 'reload schema' + 'reload config'. This
//                          is the documented Supabase remedy and is zero-impact.
//   RECYCLE=1 (with apply+confirm)
//                        — ALSO pg_terminate_backend() PostgREST's authenticator
//                          connections so it reconnects fresh (clears the stale
//                          pool). PostgREST auto-reconnects; brief per-request
//                          blip. Use only if the NOTIFY reload did not restore.
//
// RE-RUN: idempotent. A second plan run reports state again; a second apply
//   re-sends the same harmless NOTIFYs; a second recycle terminates whatever
//   PostgREST connections exist at that moment (it always reconnects).
//
// VERIFY: re-reads pg_stat_activity on a FRESH connection after acting and prints
//   PostgREST's connection ages, so a recycle is visible (old backends gone).
//   NOTE: the DEFINITIVE proof is the app's own request returning rows — that
//   lives at the PostgREST HTTP layer, which this repo's CI cannot reach (no
//   SUPABASE_SERVICE_ROLE_KEY in any Actions scope). A human must confirm the
//   live SO list shows orders again.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM || "";
const RECYCLE = process.env.RECYCLE === "1";
const CONFIRM_PHRASE = "RELOAD-PGRST";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const pgConns = (pg) => pg`
  SELECT COALESCE(application_name,'(none)') AS app, usename, state, count(*)::int AS conns,
         min(backend_start) AS oldest, max(backend_start) AS newest
    FROM pg_stat_activity
   WHERE application_name ILIKE '%postgrest%' OR usename = 'authenticator'
   GROUP BY application_name, usename, state ORDER BY conns DESC`;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  notice(`MODE=${MODE} RECYCLE=${RECYCLE ? "1" : "0"}`);
  notice("---- PostgREST connections BEFORE ----");
  for (const r of await pgConns(pg)) notice(`app=${r.app} user=${r.usename} state=${r.state} conns=${r.conns} oldest=${r.oldest?.toISOString?.() ?? r.oldest}`);

  if (MODE !== "apply") {
    notice(`PLAN ONLY — would run: NOTIFY pgrst,'reload schema'; NOTIFY pgrst,'reload config';${RECYCLE ? " + terminate authenticator backends" : ""}`);
    notice(`To act: set MODE=apply and CONFIRM=${CONFIRM_PHRASE}${RECYCLE ? " with RECYCLE=1" : ""}.`);
  } else if (CONFIRM !== CONFIRM_PHRASE) {
    notice(`REFUSED — MODE=apply requires CONFIRM=${CONFIRM_PHRASE} (got ${CONFIRM ? "a different value" : "empty"}). Nothing sent.`);
    process.exit(1);
  } else {
    await pg.unsafe("NOTIFY pgrst, 'reload schema'");
    await pg.unsafe("NOTIFY pgrst, 'reload config'");
    notice("SENT: NOTIFY pgrst 'reload schema' + 'reload config'.");
    if (RECYCLE) {
      const killed = await pg`
        SELECT pg_terminate_backend(pid) AS ok, pid
          FROM pg_stat_activity
         WHERE usename = 'authenticator'
           AND (application_name ILIKE '%postgrest%')
           AND pid <> pg_backend_pid()`;
      notice(`RECYCLED: asked ${killed.length} PostgREST authenticator backend(s) to close (PostgREST auto-reconnects).`);
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}

// VERIFY on a FRESH connection.
if (MODE === "apply" && CONFIRM === CONFIRM_PHRASE) {
  const pg2 = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    notice("---- PostgREST connections AFTER (fresh connection) ----");
    for (const r of await pgConns(pg2)) notice(`app=${r.app} user=${r.usename} state=${r.state} conns=${r.conns} oldest=${r.oldest?.toISOString?.() ?? r.oldest}`);
    notice("NEXT: a human must confirm the live Sales Orders list shows orders again (PostgREST HTTP layer is not reachable from CI).");
  } finally {
    await pg2.end({ timeout: 5 });
  }
}
