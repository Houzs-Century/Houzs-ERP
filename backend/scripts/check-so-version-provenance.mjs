// READ-ONLY forensic report: what did the ERP-side "edits" on the 81 conflicted
// sales orders actually CHANGE?
//
// WHY THIS EXISTS
//
// sync-ac-delta.mjs REFUSES to write an AutoCount change into an ERP order when
// it believes "a person edited this order in the ERP". Its test for that is two
// armed (sync-ac-delta.mjs:177-183):
//
//   arm 1  a scm.mfg_so_audit_log row whose field_changes matches TOUCHED_NEEDLES
//   arm 2  scm.mfg_sales_orders.version > 1
//
// On production run 34097966565 arm 1 caught 3 orders and arm 2 caught the other
// 200 (203 total), and 81 of those collided with an AutoCount edit. The owner's
// challenge is that arm 2 does not mean "a person edited this order" at all.
//
// Reading the code says he is probably right: `version` has NO database default
// beyond 1 and (as far as the migration tree shows) no trigger, but
// scm/lib/so-generation.ts `advanceSoGeneration` — documented as the "canonical
// system/mirror writer" that "participates in the same monotonically increasing
// generation as human edits" — bumps it, and it is called by SEVEN automated
// paths (stock allocation, delivery sync, trip reconcile, DO create/amend
// mirror, delivery planning, the SO sweep). None of those is a person.
//
// READING CODE IS EVIDENCE ABOUT INTENT, NEVER ABOUT PRODUCTION. This script
// settles it against the live database, and it is written to be able to REFUTE
// the hypothesis as easily as confirm it: section A dumps every trigger and rule
// on the table whether or not one exists, and section G reports "unexplained" as
// a first-class bucket rather than forcing every row into a cause.
//
// STRICTLY READ-ONLY. Every statement below is a SELECT. No DDL, no INSERT /
// UPDATE / DELETE, no transaction, no temp table. Exits 0 for every legitimate
// answer — the ANSWER is the output, so a red job would read as "the check
// broke". Only an unreachable database or a query error exits non-zero.
//
//   node scripts/check-so-version-provenance.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const raw = (m) => console.log(m);

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return fs.readFileSync(path.join(here, "..", ".dev.vars"), "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set (env var or .dev.vars). Aborting."); process.exit(1); }

// The SAME needle list sync-ac-delta.mjs uses, imported rather than retyped so
// this report cannot drift from the script whose verdict it is auditing.
const { SO_HEADER_LEGACY_PAYLOAD_KEYS, SO_PROCESSING_DATE_COLUMN,
        SO_PROCESSING_DATE_LEGACY_COLUMNS, SO_PROCESSING_DATE_PAYLOAD_KEY } =
  await import("./lib/so-processing-date.mjs");
const TOUCHED_NEEDLES = [
  "proceeded_at", "proceededAt",
  SO_PROCESSING_DATE_COLUMN, SO_PROCESSING_DATE_PAYLOAD_KEY,
  ...SO_PROCESSING_DATE_LEGACY_COLUMNS,
  ...Object.keys(SO_HEADER_LEGACY_PAYLOAD_KEYS),
  "Processing Date", "customer_delivery_date", "customerDeliveryDate",
  "remark2", "remark3", "remark4", "Remark 2", "Remark 3", "Remark 4",
  "sales_exemption_expiry", "salesExemptionExpiry", '"note"', "'note'",
  "description", "description2", "Description", "Desc2",
  "unit_price_sen", "total_sen", "balance_sen", "paid_sen", "deposit_sen",
  "payment", "payments", "item_code", "qty", "variants", "custom_specials",
].map((n) => `%${n}%`);

const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const j = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
const cut = (s, n) => { const t = s == null ? "" : String(s); return t.length > n ? `${t.slice(0, n)}…` : t; };

try {
  // ══════════════════════════════════════════════════════════════════════════
  // A.  WHAT BUMPS `version`? — the live schema, not the migration tree.
  // ══════════════════════════════════════════════════════════════════════════
  log("A. TRIGGERS / RULES / DEFAULTS ON scm.mfg_sales_orders (live schema)");
  const trig = await sql`
    SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
     WHERE t.tgrelid = 'scm.mfg_sales_orders'::regclass AND NOT t.tgisinternal
     ORDER BY t.tgname`;
  if (!trig.length) log("   triggers on scm.mfg_sales_orders: NONE");
  else for (const t of trig) log(`   trigger ${t.tgname}: ${cut(t.def, 400)}`);

  const trigItems = await sql`
    SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
     WHERE t.tgrelid = 'scm.mfg_sales_order_items'::regclass AND NOT t.tgisinternal
     ORDER BY t.tgname`;
  if (!trigItems.length) log("   triggers on scm.mfg_sales_order_items: NONE");
  else for (const t of trigItems) log(`   trigger (items) ${t.tgname}: ${cut(t.def, 400)}`);

  const rules = await sql`
    SELECT rulename, definition FROM pg_rules
     WHERE schemaname = 'scm' AND tablename IN ('mfg_sales_orders','mfg_sales_order_items')`;
  if (!rules.length) log("   rewrite rules on either table: NONE");
  else for (const r of rules) log(`   rule ${r.rulename}: ${cut(r.definition, 300)}`);

  const cols = await sql`
    SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders'
       AND column_name IN ('version','updated_at','created_at','status')
     ORDER BY column_name`;
  for (const c of cols) log(`   column ${c.column_name} ${c.data_type} default=${c.column_default ?? "NULL"} nullable=${c.is_nullable}`);

  // ══════════════════════════════════════════════════════════════════════════
  // B.  THE POPULATION — every migrated SO, by version.
  // ══════════════════════════════════════════════════════════════════════════
  log("B. VERSION DISTRIBUTION over the migrated sales orders (company 1, linked to AutoCount)");
  const dist = await sql`
    SELECT version, count(*)::int AS n
      FROM scm.mfg_sales_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL
     GROUP BY version ORDER BY version`;
  let tot = 0; for (const d of dist) tot += d.n;
  for (const d of dist) log(`   version ${String(d.version).padStart(3)}  ${String(d.n).padStart(5)} order(s)`);
  log(`   TOTAL ${tot}`);

  // ══════════════════════════════════════════════════════════════════════════
  // C.  REBUILD THE EXACT 81 — same inputs, same rule as sync-ac-delta.mjs.
  // ══════════════════════════════════════════════════════════════════════════
  const S = gz("ac-doc-stamps.json.gz").rows;
  log(`C. REBUILDING THE CONFLICT SET from the same snapshot (since=${S.since} exported=${S.exportedAt})`);

  const soHeaders = await sql`
    SELECT doc_no, linked_ac_docno, version, status, created_at, updated_at
      FROM scm.mfg_sales_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`;
  const erpSoByAc = new Map(soHeaders.map((h) => [h.linked_ac_docno, h]));
  const byDoc = new Map(soHeaders.map((h) => [h.doc_no, h]));

  const allSoDocs = soHeaders.map((h) => h.doc_no);
  const auditTouched = new Set();
  for (let i = 0; i < allSoDocs.length; i += 2000) {
    const rows = await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ANY(${allSoDocs.slice(i, i + 2000)}) AND field_changes::text ILIKE ANY(${TOUCHED_NEEDLES})`;
    for (const r of rows) auditTouched.add(r.so_doc_no);
  }
  const versionTouched = new Set(soHeaders.filter((h) => Number(h.version) > 1).map((h) => h.doc_no));
  const touched = new Set([...auditTouched, ...versionTouched]);
  log(`   caught by the AUDIT TRAIL arm : ${auditTouched.size}`);
  log(`   caught by the version > 1 arm : ${versionTouched.size}`);
  log(`   union (what the script calls "a person has edited") : ${touched.size}`);
  const auditOnly = [...auditTouched].filter((d) => !versionTouched.has(d));
  log(`   audit-trail orders that are STILL version 1 : ${auditOnly.length}${auditOnly.length ? ` -> ${auditOnly.join(", ")}` : ""}`);

  const editedSo = (S.stamps.SO || []).filter((r) => !(r.Created && String(r.Created) >= S.since) && erpSoByAc.has(r.DocNo));
  const conflicts = [];
  for (const st of editedSo) {
    const h = erpSoByAc.get(st.DocNo);
    if (touched.has(h.doc_no)) conflicts.push({ acDoc: st.DocNo, doc: h.doc_no, acModified: st.Modified, h });
  }
  conflicts.sort((a, b) => a.doc.localeCompare(b.doc));
  log(`   CONFLICTS rebuilt: ${conflicts.length} (run 34097966565 reported 81)`);

  raw("=== ENUMERATION: every conflicted sales order, complete, no truncation ===");
  raw("doc_no          ac_doc       ver  status              erp_updated_at                 ac_modified               arm");
  for (const c of conflicts) {
    const arm = auditTouched.has(c.doc) ? (Number(c.h.version) > 1 ? "AUDIT+VER" : "AUDIT") : "VERSION";
    raw(`${c.doc.padEnd(15)} ${c.acDoc.padEnd(12)} ${String(c.h.version).padStart(3)}  ${String(c.h.status ?? "-").padEnd(19)} ${String(c.h.updated_at ?? "-").padEnd(30)} ${String(c.acModified ?? "-").padEnd(25)} ${arm}`);
  }
  raw("=== END ENUMERATION ===");

  const conflictDocs = conflicts.map((c) => c.doc);

  // ══════════════════════════════════════════════════════════════════════════
  // D.  THE AUDIT-TRAIL ORDERS — name the change, in full.
  // ══════════════════════════════════════════════════════════════════════════
  log("D. THE ORDERS THE AUDIT TRAIL CAUGHT — every matching row, verbatim");
  const auditDocs = [...auditTouched];
  if (!auditDocs.length) log("   NONE. The audit-trail arm caught nothing on this run.");
  else {
    const rows = await sql`
      SELECT so_doc_no, action, actor_id, actor_name_snapshot, source, note,
             status_snapshot, created_at, field_changes::text AS fc
        FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ANY(${auditDocs}) AND field_changes::text ILIKE ANY(${TOUCHED_NEEDLES})
       ORDER BY so_doc_no, created_at`;
    log(`   ${rows.length} matching audit row(s) across ${auditDocs.length} order(s)`);
    for (const r of rows) {
      const inConflict = conflictDocs.includes(r.so_doc_no) ? "IN THE 81" : "not in the 81";
      raw(`   ${r.so_doc_no}  [${inConflict}]  ${r.created_at}`);
      raw(`      action=${r.action}  actor_id=${r.actor_id ?? "NULL"}  actor="${r.actor_name_snapshot ?? "-"}"  source=${r.source ?? "-"}`);
      raw(`      note=${cut(r.note, 200)}`);
      raw(`      field_changes=${cut(r.fc, 1200)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // E.  WHO WROTE THE AUDIT ROWS ON THE CONFLICTED ORDERS — human vs machine.
  // ══════════════════════════════════════════════════════════════════════════
  log("E. ALL audit activity on the conflicted orders, grouped by actor and source");
  const actorMix = await sql`
    SELECT COALESCE(actor_name_snapshot, '(null)') AS actor,
           COALESCE(source, '(null)') AS source,
           action,
           (actor_id IS NULL) AS system_actor,
           count(*)::int AS n,
           count(DISTINCT so_doc_no)::int AS docs,
           min(created_at) AS first_at, max(created_at) AS last_at
      FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ANY(${conflictDocs})
     GROUP BY 1,2,3,4 ORDER BY n DESC`;
  if (!actorMix.length) log("   NO audit rows at all on any of the conflicted orders.");
  for (const a of actorMix) {
    log(`   ${String(a.n).padStart(5)} row(s) / ${String(a.docs).padStart(3)} order(s)  actor="${a.actor}" source=${a.source} action=${a.action} system=${a.system_actor}  ${a.first_at} .. ${a.last_at}`);
  }

  const noAudit = await sql`
    SELECT h.doc_no FROM scm.mfg_sales_orders h
     WHERE h.doc_no = ANY(${conflictDocs})
       AND NOT EXISTS (SELECT 1 FROM scm.mfg_so_audit_log a WHERE a.so_doc_no = h.doc_no)
     ORDER BY h.doc_no`;
  log(`   conflicted orders with NO audit row whatsoever: ${noAudit.length}`);
  if (noAudit.length) raw(`      ${noAudit.map((r) => r.doc_no).join(", ")}`);

  const humanAudit = await sql`
    SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ANY(${conflictDocs}) AND actor_id IS NOT NULL`;
  log(`   conflicted orders carrying at least one audit row written by a REAL staff account: ${humanAudit.length}`);
  if (humanAudit.length) raw(`      ${humanAudit.map((r) => r.so_doc_no).sort().join(", ")}`);

  // ══════════════════════════════════════════════════════════════════════════
  // F.  AMENDMENTS / REVISIONS — the only path that rewrites lines with a person.
  // ══════════════════════════════════════════════════════════════════════════
  log("F. so_revisions + so_amendments on the conflicted orders");
  const revs = await sql`
    SELECT so_doc_no, count(*)::int AS n, min(created_at) AS first_at, max(created_at) AS last_at,
           count(*) FILTER (WHERE created_by IS NOT NULL)::int AS by_person
      FROM scm.so_revisions WHERE so_doc_no = ANY(${conflictDocs})
     GROUP BY so_doc_no ORDER BY so_doc_no`;
  log(`   conflicted orders with a so_revisions snapshot: ${revs.length}`);
  for (const r of revs) raw(`      ${r.so_doc_no}  ${r.n} revision(s), ${r.by_person} with a named author, ${r.first_at} .. ${r.last_at}`);

  // ══════════════════════════════════════════════════════════════════════════
  // G.  ATTRIBUTE EACH VERSION BUMP. "Unexplained" is a real bucket.
  // ══════════════════════════════════════════════════════════════════════════
  log("G. ATTRIBUTION — what moved each conflicted order off version 1");

  // The automated status sweep is the leading hypothesis: advanceSoGeneration
  // bumps `version` and its caller writes an audit row with a NULL actor.
  const autoStatus = await sql`
    SELECT so_doc_no, count(*)::int AS n, min(created_at) AS first_at, max(created_at) AS last_at,
           string_agg(DISTINCT COALESCE(actor_name_snapshot,'(null)'), ' | ') AS actors
      FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ANY(${conflictDocs}) AND actor_id IS NULL AND action = 'UPDATE_STATUS'
     GROUP BY so_doc_no`;
  const autoByDoc = new Map(autoStatus.map((r) => [r.so_doc_no, r]));

  const statusChanges = await sql`
    SELECT doc_no, count(*)::int AS n,
           count(*) FILTER (WHERE changed_by IS NULL)::int AS by_system,
           min(created_at) AS first_at, max(created_at) AS last_at
      FROM scm.mfg_so_status_changes WHERE doc_no = ANY(${conflictDocs})
     GROUP BY doc_no`;
  const scByDoc = new Map(statusChanges.map((r) => [r.doc_no, r]));

  const humanSet = new Set(humanAudit.map((r) => r.so_doc_no));
  const revSet = new Set(revs.map((r) => r.so_doc_no));

  const buckets = new Map();
  const rowsOut = [];
  for (const c of conflicts) {
    const h = c.h;
    const bumps = Number(h.version) - 1;
    const auto = autoByDoc.get(c.doc);
    const sc = scByDoc.get(c.doc);
    let bucket;
    if (humanSet.has(c.doc)) bucket = "a named staff account touched it";
    else if (revSet.has(c.doc)) bucket = "an amendment revision exists";
    else if (auto && auto.n >= bumps) bucket = "automated status sweep (accounts for every bump)";
    else if (auto) bucket = "automated status sweep (accounts for SOME bumps)";
    else if (sc && sc.by_system > 0) bucket = "system status change, no audit row";
    else bucket = "UNEXPLAINED";
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    rowsOut.push({ doc: c.doc, ver: h.version, bumps, auto: auto?.n ?? 0,
                   autoWhen: auto ? `${auto.first_at}` : "-", sc: sc?.n ?? 0, scSys: sc?.by_system ?? 0,
                   upd: h.updated_at, bucket });
  }
  log("   BUCKETS:");
  for (const [b, n] of [...buckets.entries()].sort((a, b2) => b2[1] - a[1])) log(`     ${String(n).padStart(3)}  ${b}`);

  raw("=== ENUMERATION: per-order attribution, all rows ===");
  raw("doc_no          ver bumps auto_status_rows status_change_rows(sys) erp_updated_at                 bucket");
  for (const r of rowsOut) {
    raw(`${r.doc.padEnd(15)} ${String(r.ver).padStart(3)} ${String(r.bumps).padStart(5)} ${String(r.auto).padStart(16)} ${`${r.sc}(${r.scSys})`.padStart(23)} ${String(r.upd ?? "-").padEnd(30)} ${r.bucket}`);
  }
  raw("=== END ENUMERATION ===");

  // When did the header last move? A repair script run shows up as a tight
  // cluster of identical timestamps; organic human editing does not.
  log("H. WHEN the conflicted headers last moved (updated_at, bucketed by hour)");
  const hours = await sql`
    SELECT date_trunc('hour', updated_at) AS hr, count(*)::int AS n
      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${conflictDocs}) AND updated_at IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  for (const h of hours) log(`   ${h.hr}  ${String(h.n).padStart(3)} order(s)`);

  // Same question for the WHOLE version>1 population, so a repair-script cluster
  // that missed the 81 still shows up.
  log("I. Same hourly picture for ALL version > 1 orders (the 203), to expose script runs");
  const hours2 = await sql`
    SELECT date_trunc('hour', updated_at) AS hr, count(*)::int AS n
      FROM scm.mfg_sales_orders
     WHERE company_id = 1 AND linked_ac_docno IS NOT NULL AND version > 1 AND updated_at IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  for (const h of hours2) log(`   ${h.hr}  ${String(h.n).padStart(3)} order(s)`);

  // NAME THE CHANGE in business language. Whatever moved these orders wrote a
  // reason somewhere; print the distinct reasons rather than inferring one.
  // (scm.mfg_sales_order_items has no updated_at column, so there is no
  // line-level mtime to correlate — say so instead of faking the measurement.)
  log("J. THE REASONS ON RECORD — distinct notes written against the conflicted orders");
  const notes = await sql`
    SELECT COALESCE(notes,'(null)') AS note, count(*)::int AS n,
           count(DISTINCT doc_no)::int AS docs,
           count(*) FILTER (WHERE changed_by IS NULL)::int AS by_system
      FROM scm.mfg_so_status_changes WHERE doc_no = ANY(${conflictDocs})
     GROUP BY 1 ORDER BY n DESC LIMIT 40`;
  if (!notes.length) log("   no mfg_so_status_changes rows on the conflicted orders");
  for (const n of notes) log(`   ${String(n.n).padStart(5)}x / ${String(n.docs).padStart(3)} order(s)  system=${n.by_system}  "${cut(n.note, 160)}"`);

  const anotes = await sql`
    SELECT COALESCE(note,'(null)') AS note, action,
           COALESCE(actor_name_snapshot,'(null)') AS actor,
           count(*)::int AS n, count(DISTINCT so_doc_no)::int AS docs
      FROM scm.mfg_so_audit_log WHERE so_doc_no = ANY(${conflictDocs})
     GROUP BY 1,2,3 ORDER BY n DESC LIMIT 40`;
  for (const n of anotes) log(`   audit ${String(n.n).padStart(5)}x / ${String(n.docs).padStart(3)} order(s)  action=${n.action} actor="${n.actor}"  "${cut(n.note, 140)}"`);

  // ══════════════════════════════════════════════════════════════════════════
  // K.  IS ANYTHING ACTUALLY CONTESTED?
  //
  // sync-ac-delta.mjs `continue`s on a conflict BEFORE it computes the desc2
  // diff (sync-ac-delta.mjs:238) and skips the order in the payment lane too
  // (`if (touched.has(h.doc_no)) continue;`, :309). So its own headline numbers
  // — "75 desc2 line(s)", "REFUSED, a person owns the payment rows 0" — are
  // measured over the NON-conflicted orders only. Nobody has ever asked what
  // the 81 actually disagree about. Ask now, with the same comparison.
  // ══════════════════════════════════════════════════════════════════════════
  log("K. WHAT IS ACTUALLY CONTESTED ON THE 81 — the per-field tests that never ran");
  const txt = (v) => { const s = (v == null ? "" : String(v)).trim(); return s === "" ? null : s; };
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
  const centi = (v) => Math.round(num(v) * 100);

  const soRows = gz("ac-outstanding-so.json.gz");
  const acLineByDtl = new Map();
  for (const r of soRows) acLineByDtl.set(String(r.DtlKey), r);
  const acSoHeader = new Map();
  for (const r of soRows) if (!acSoHeader.has(r.DocNo)) acSoHeader.set(r.DocNo, r);
  const acSoLines = new Map();
  for (const r of soRows) { if (!acSoLines.has(r.DocNo)) acSoLines.set(r.DocNo, []); acSoLines.get(r.DocNo).push(r); }

  const items = await sql`
    SELECT i.id, i.doc_no, i.linked_ac_dtlkey, i.description2
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no = ANY(${conflictDocs}) AND COALESCE(i.cancelled, false) = false`;
  const itemsByDoc = new Map();
  for (const i of items) { if (!itemsByDoc.has(i.doc_no)) itemsByDoc.set(i.doc_no, []); itemsByDoc.get(i.doc_no).push(i); }

  const money = await sql`
    SELECT doc_no, local_total_sen, balance_sen, paid_sen FROM scm.mfg_sales_orders
     WHERE doc_no = ANY(${conflictDocs})`;
  const moneyByDoc = new Map(money.map((m) => [m.doc_no, m]));

  const pays = await sql`
    SELECT so_doc_no, method, note FROM scm.mfg_sales_order_payments
     WHERE so_doc_no = ANY(${conflictDocs}) AND company_id = 1`;
  const paysByDoc = new Map();
  for (const p of pays) { if (!paysByDoc.has(p.so_doc_no)) paysByDoc.set(p.so_doc_no, []); paysByDoc.get(p.so_doc_no).push(p); }

  let nDesc = 0, nMoney = 0, nNothing = 0, nNoBook = 0, nPersonOwnsMoney = 0;
  const descDetail = [];
  for (const c of conflicts) {
    const bookLines = acSoLines.get(c.acDoc);
    if (!bookLines) { nNoBook++; continue; }
    let d2 = 0;
    for (const l of (itemsByDoc.get(c.doc) || [])) {
      if (l.linked_ac_dtlkey == null) continue;
      const bl = acLineByDtl.get(String(l.linked_ac_dtlkey));
      if (!bl) continue;
      const want = txt(bl.Desc2), cur = txt(l.description2);
      if (want !== null && want !== cur) { d2++; descDetail.push({ doc: c.doc, dtl: l.linked_ac_dtlkey, from: cur, to: want }); }
    }
    const bh = acSoHeader.get(c.acDoc);
    const total = bookLines.reduce((a, l) => a + centi(l.UnitPrice) * (Math.round(num(l.Qty)) || 1), 0);
    const bal = centi(bh.UDF_BALANCE);
    const paid = Math.max(0, total - bal);
    const m = moneyByDoc.get(c.doc);
    const moneyMoved = m && !(Number(m.local_total_sen) === total && Number(m.balance_sen) === bal && Number(m.paid_sen) === paid);
    const rows = paysByDoc.get(c.doc) || [];
    const migrated = rows.filter((p) => p.method === "imported" && /^imported from AutoCount/.test(p.note || ""));
    const personOwnsMoney = rows.length !== migrated.length || migrated.length > 1;
    if (d2) nDesc++;
    if (moneyMoved) nMoney++;
    if (moneyMoved && personOwnsMoney) nPersonOwnsMoney++;
    if (!d2 && !moneyMoved) nNothing++;
  }
  log(`   of the ${conflicts.length} refused orders:`);
  log(`     ${String(nDesc).padStart(3)} have a description2 difference the sync WOULD have written`);
  log(`     ${String(nMoney).padStart(3)} have money that moved in the book`);
  log(`     ${String(nPersonOwnsMoney).padStart(3)} of those money movers ALSO have a payment row a person owns (a REAL conflict)`);
  log(`     ${String(nNothing).padStart(3)} have NEITHER — refused over nothing at all`);
  log(`     ${String(nNoBook).padStart(3)} have no book lines in the outstanding snapshot (out of this lane's scope)`);
  raw("=== ENUMERATION: the description2 differences suppressed by the refusal ===");
  for (const d of descDetail) raw(`${d.doc} dtl=${d.dtl}: ${j(d.from)} -> ${j(d.to)}`);
  raw("=== END ENUMERATION ===");

  log("REPORT COMPLETE — nothing was written.");
} catch (err) {
  console.error(`check-so-version-provenance FAILED: ${err?.message ?? err}`);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
