// Read-only probe: WHICH Sales Orders were re-attributed from one salesperson to
// another, and their exact doc numbers — so a follow-up SHARE ("Also give access
// to") can target only that batch.
//
// Owner 2026-09-10: Kingsley's orders were handed to Shawn (Kingsley stays
// disabled). His orders now need Stanley + Shawn to follow up. Shawn already
// HOLDS them; the missing piece is granting Stanley access to that exact batch.
// But "From = Shawn" in the Handover panel lists ALL of Shawn's orders (his own
// plus the ones taken over), and a share must not spill onto Shawn's own. This
// probe reads the audit trail and prints, per (from -> to) pair, the doc numbers
// that actually moved — the list to select in the panel.
//
// WHAT IT ANSWERS, and nothing else: every `salespersonId` change recorded in
// scm.mfg_so_audit_log within the window, grouped by (from-rep -> to-rep) with a
// count and the doc numbers. That covers both the bulk Handover /apply and the
// per-order Salesperson change on SO Detail — both write the same field change.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job reads as "the check broke", and the ANSWER is
// the output. Only an unreachable database or a query error exits non-zero.
// Manual dispatch only, own concurrency group, never on a schedule. Re-running
// is safe and free: it reads and prints, nothing changes.
//
// The audit stores field_changes as a jsonb array of { field, from, to }; for
// salespersonId the from/to are staff UUIDs (a first-ever attribution has a null
// `from`). We resolve each to its staff name, and fall back to the raw id when a
// staff row no longer resolves — a uuid on screen is still information, and a
// blank would hide a real move.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const note = (s) => console.log(`::notice::${s}`);
const WINDOW_DAYS = 180;

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error("No DATABASE_URL (env or backend/.dev.vars). Cannot answer.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

  try {
    const rows = await sql`
      SELECT a.so_doc_no                       AS doc_no,
             a.created_at                      AS at,
             a.actor_name_snapshot            AS actor,
             a.company_id                      AS company_id,
             fc->>'from'                       AS from_id,
             fc->>'to'                         AS to_id,
             sf.name                           AS from_name,
             sf.staff_code                     AS from_code,
             st.name                           AS to_name,
             st.staff_code                     AS to_code
        FROM scm.mfg_so_audit_log a
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.field_changes) = 'array'
               THEN a.field_changes ELSE '[]'::jsonb END
        ) fc
        LEFT JOIN scm.staff sf ON sf.id::text = NULLIF(fc->>'from', '')
        LEFT JOIN scm.staff st ON st.id::text = NULLIF(fc->>'to', '')
       WHERE fc->>'field' = 'salespersonId'
         AND a.created_at > now() - (${WINDOW_DAYS} || ' days')::interval
       ORDER BY a.created_at DESC`;

    if (rows.length === 0) {
      note(`No salespersonId reattributions recorded in the last ${WINDOW_DAYS} days.`);
      return;
    }

    /* Group by (from -> to). A rep's name is the display key; the raw id rides
       along so a name collision can still be told apart, and an unresolved id
       shows the uuid rather than a blank. */
    const label = (name, code, id) =>
      name ? `${name}${code ? ` (${code})` : ""}` : id ? `id ${id}` : "(unattributed)";
    const groups = new Map();
    for (const r of rows) {
      const from = label(r.from_name, r.from_code, r.from_id);
      const to = label(r.to_name, r.to_code, r.to_id);
      const key = `${from}  ->  ${to}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    note(`salespersonId reattributions in the last ${WINDOW_DAYS} days, grouped by from -> to:`);
    note(`(both the bulk Handover and a per-order Salesperson change appear here)`);

    /* Biggest batches first — the one an operator is chasing is usually the big
       recent move. */
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [key, recs] of ordered) {
      note(`---- ${key} : ${recs.length} order(s) ----`);
      /* Doc numbers on one line, comma-separated, so they can be read or copied
         straight into the panel's selection. */
      const docs = recs.map((r) => r.doc_no).sort();
      note(`  ${docs.join(", ")}`);
      /* When + who, newest first, so a stale or mistaken batch is identifiable. */
      const first = recs[0];
      const last = recs[recs.length - 1];
      const span =
        recs.length === 1
          ? `${fmt(first.at)}`
          : `${fmt(last.at)} .. ${fmt(first.at)}`;
      const actors = [...new Set(recs.map((r) => r.actor).filter(Boolean))].join(", ");
      note(`  when: ${span}${actors ? `   by: ${actors}` : ""}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function fmt(ts) {
  if (!ts) return "?";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

main().catch((e) => {
  console.error(`check-so-handover-audit failed: ${e?.message ?? e}`);
  process.exit(1);
});
