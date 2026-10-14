// Re-stamp OLD sales-order headers whose branding the BUG-115 rule (PR #4594)
// would not stamp today — the rows check-so-header-branding.mjs lists, e.g.
// HC-SO-2609-336 headed BEDFRAME while its only line is a Dunlopillo mattress.
//
// WHAT IT WRITES, per order: scm.mfg_sales_orders.branding := the brand
// restampHeaderBranding derives from the live lines (the app's own
// pickHeaderBranding, via lib/so-header-branding-drift.mjs). Same fair rule as
// the app: project_id null and fair_match AMBIGUOUS / UNMATCHED -> PENDING, so
// the nightly reconcile retries the booth match with the right brand. One
// scm.mfg_so_audit_log row per order records from / to. Nothing else: lines,
// status, AutoCount and the version column are untouched, as in the app.
// Left alone, as in the app: migrated orders (linked_ac_docno set) and orders
// with a live DO / SI. trg_vp_outbox_so fires on UPDATE OF branding; the plan
// prints the live triggers that fire.
//
//   DATABASE_URL  required
//   COMPANY       required: HOUZS | 2990 (every statement is company-scoped)
//   MODE          plan (default) | apply
//   CONFIRM       required on apply: repair-so-header-branding
//
// Apply is ONE transaction; each UPDATE is guarded on the branding and
// fair_match the plan read and on "still no live DO / SI", so a header that
// moved since the plan rolls the whole run back. Then a FRESH connection
// re-reads every written header and checks its shape: holds the planned brand,
// fair_match as planned, one audit row, and a fresh plan no longer lists it.
//
// RE-RUN: idempotent. A re-stamped header equals what the rule derives, so a
// second run finds nothing for those orders.
import postgres from "postgres";
import { pairCounts, readHeaderBrandingDrift } from "./lib/so-header-branding-drift.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "repair-so-header-branding";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${CONFIRM_PHRASE} — refusing to write.`);
  process.exit(2);
}
const COMPANY = String(process.env.COMPANY ?? "").trim().toUpperCase();
if (COMPANY !== "HOUZS" && COMPANY !== "2990") { console.error("COMPANY must be HOUZS or 2990"); process.exit(2); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m) => console.log(m);
const shown = (v) => (v == null ? "(null)" : JSON.stringify(v));
const ACTOR = "System (BUG-115 header branding repair)";

async function plan(sql) {
  const [co] = await sql`SELECT id, code FROM companies WHERE upper(code) = ${COMPANY}`;
  if (!co) throw new Error(`company ${COMPANY} not found — refusing to run`);
  const p = await readHeaderBrandingDrift(sql, co);
  if (p.listFallback.brands.length === 0) throw new Error(`no active project_brands for ${COMPANY} — refusing to run`);
  return p;
}

function report(p) {
  log(`${p.code} (company_id=${p.cid}) MODE=${MODE}: ${p.affected.length} to re-stamp; left alone ${p.skippedMigrated.length} migrated, ${p.skippedDownstream.length} with a live DO/SI`);
  for (const [k, n] of pairCounts(p.affected)) out(`  PAIR\t${k}\tx${n}`);
  for (const h of p.affected) {
    out(`  RESTAMP\t${h.doc_no}\t${shown(h.branding)} -> ${shown(h.derived)}\tstatus=${h.status}\tso_date=${h.so_date ?? "(null)"}${h.repend ? `\tfair_match ${h.fair_match} -> PENDING` : ""}`);
  }
}

async function triggers(sql) {
  const rows = await sql`
    SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders' AND NOT t.tgisinternal ORDER BY 1`;
  const fires = (def) => {
    if (!/\bUPDATE\b/.test(def)) return false;
    const of = def.match(/UPDATE OF (.*?) ON /);
    return !of || of[1].split(",").map((c) => c.trim()).some((c) => c === "branding" || c === "fair_match");
  };
  log(`triggers that fire on this UPDATE: ${rows.filter((t) => fires(t.def)).map((t) => t.name).join(", ") || "none"}`);
}

async function apply(sql, p) {
  await sql.begin(async (tx) => {
    for (const h of p.affected) {
      const patch = h.repend ? { branding: h.derived, fair_match: "PENDING" } : { branding: h.derived };
      const r = await tx`
        UPDATE scm.mfg_sales_orders SET ${tx(patch)}
         WHERE company_id = ${p.cid} AND doc_no = ${h.doc_no}
           AND branding IS NOT DISTINCT FROM ${h.branding}
           AND fair_match IS NOT DISTINCT FROM ${h.fair_match}
           AND coalesce(linked_ac_docno, '') = ''
           AND NOT EXISTS (SELECT 1 FROM scm.delivery_orders d WHERE d.so_doc_no = ${h.doc_no} AND d.status <> 'CANCELLED')
           AND NOT EXISTS (SELECT 1 FROM scm.sales_invoices s WHERE s.so_doc_no = ${h.doc_no} AND s.status <> 'CANCELLED')`;
      if (r.count !== 1) throw new Error(`${h.doc_no}: expected 1 row still as planned, updated ${r.count} — rolled back, nothing written`);
      const changes = [{ field: "branding", from: h.branding, to: h.derived }];
      if (h.repend) changes.push({ field: "fair_match", from: h.fair_match, to: "PENDING" });
      await tx`
        INSERT INTO scm.mfg_so_audit_log
          (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
        VALUES
          (${h.doc_no}, ${p.cid}, 'UPDATE', ${ACTOR}, ${tx.json(changes)}, ${h.status}, 'script',
           ${`BUG-115: header branding re-derived from the live lines (${shown(h.branding)} -> ${shown(h.derived)}). Stamped once at create and never re-derived before PR #4594.`})`;
    }
    log(`applied: ${p.affected.length} headers (one transaction)`);
  });
}

async function verify(p) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const problems = [];
    for (const h of p.affected) {
      const [r] = await fresh`SELECT branding, fair_match FROM scm.mfg_sales_orders WHERE company_id = ${p.cid} AND doc_no = ${h.doc_no}`;
      if (!r) { problems.push(`${h.doc_no}: vanished`); continue; }
      if (r.branding !== h.derived) problems.push(`${h.doc_no}: holds ${shown(r.branding)}, planned ${shown(h.derived)}`);
      const fm = h.repend ? "PENDING" : h.fair_match;
      if (r.fair_match !== fm) problems.push(`${h.doc_no}: fair_match ${shown(r.fair_match)}, planned ${shown(fm)}`);
      const [a] = await fresh`
        SELECT count(*)::int AS n, bool_and(jsonb_typeof(field_changes::jsonb) = 'array') AS arr FROM scm.mfg_so_audit_log
         WHERE company_id = ${p.cid} AND so_doc_no = ${h.doc_no} AND actor_name_snapshot = ${ACTOR}`;
      if (a.n < 1 || !a.arr) problems.push(`${h.doc_no}: audit row missing or field_changes not an array`);
    }
    const again = await fresh.begin("read only", (tx) => plan(tx));
    const still = new Set(again.affected.map((h) => h.doc_no));
    for (const h of p.affected) if (still.has(h.doc_no)) problems.push(`${h.doc_no}: a fresh plan still lists it`);
    if (problems.length) {
      problems.forEach((x) => log(`VERIFY FAIL: ${x}`));
      throw new Error(`${problems.length} verification failures`);
    }
    log(`VERIFY OK (fresh connection): ${p.affected.length} headers hold the derived brand, fair_match as planned, audit row present; a fresh plan lists none of them`);
  } finally { await fresh.end(); }
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const p = await sql.begin("read only", (tx) => plan(tx));
  report(p);
  await triggers(sql);
  if (!APPLY) log(`MODE=plan — nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} COMPANY=${COMPANY} to write.`);
  else if (p.affected.length === 0) log("MODE=apply — nothing to re-stamp, nothing written.");
  else { await apply(sql, p); await verify(p); }
} finally { await sql.end(); }
