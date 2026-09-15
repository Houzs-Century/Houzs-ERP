// probe-so-date-history — READ-ONLY. For named sales orders: WHEN did each one
// get the processing date, delivery dates and status it has now, and who wrote
// on the days its header moved.
//
// Owner 2026-09-15: 「那为什么之前我没有看到这些订单呢？之前都没有这些啊。你查回去看看，
// 现在突然跑出来 100 多张单，是什么问题呢？」 — asked of the 122 expired orders of
// check-mrp-stale-demand run 34974433208.
//
// Prints, over DOCS (comma list, required) and SINCE (default 2026-08-27):
//   1. header now: status, processing / delivery dates, created_at, updated_at
//   2. every mfg_so_audit_log row since SINCE, counted by day x action x source,
//      and each row that names a processing / delivery date or the status, with
//      from -> to
//   3. mfg_so_status_changes since SINCE
//   4. updated_at day vs the audit actions of that same day (what wrote it)
//   5. line created_at by day, and how many live lines carry a line date
// RE-RUN: read-only and idempotent. Exit 0 for every answer.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const DOCS = String(process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);
const SINCE = process.env.SINCE || "2026-08-27";
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
if (DOCS.length === 0) { notice("DOCS is empty — nothing to read"); process.exit(0); }

const DATE_FIELD = /processing|expected_dd|expecteddd|deliver|amended|status/i;
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }

const heads = await sql`
  SELECT doc_no, status::text AS status, processing_date::text AS pd, customer_delivery_date::text AS cdd,
         amended_delivery_date::text AS amended, (created_at AT TIME ZONE 'UTC')::date::text AS created,
         (updated_at AT TIME ZONE 'UTC')::date::text AS updated, linked_ac_docno
    FROM scm.mfg_sales_orders WHERE doc_no = ANY(${DOCS}) ORDER BY doc_no`;
notice(`=== SO date history — READ-ONLY · ${heads.length} of ${DOCS.length} docs found · since ${SINCE} ===`);
const tally = (rows, key) => rows.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
notice(`1. created: ${JSON.stringify(tally(heads, (h) => h.created))}`);
notice(`   updated: ${JSON.stringify(tally(heads, (h) => h.updated))}`);
notice(`   status: ${JSON.stringify(tally(heads, (h) => h.status))} · processing date set ${heads.filter((h) => h.pd).length} · header delivery set ${heads.filter((h) => h.cdd).length} · amended set ${heads.filter((h) => h.amended).length}`);

const audit = await sql`
  SELECT so_doc_no AS doc, created_at::text AS at, (created_at AT TIME ZONE 'UTC')::date::text AS day, action, coalesce(source, '') AS source,
         coalesce(actor_name_snapshot, '') AS actor, field_changes::text AS fc, coalesce(left(note, 120), '') AS note
    FROM scm.mfg_so_audit_log WHERE so_doc_no = ANY(${DOCS}) AND created_at >= ${SINCE}::date ORDER BY created_at`;
notice(`2. audit rows since ${SINCE}: ${audit.length} on ${new Set(audit.map((a) => a.doc)).size} docs`);
const byDay = tally(audit, (a) => `${a.day} ${a.action} [${a.source}] ${a.actor}`);
for (const [k, v] of Object.entries(byDay).sort()) say(`   ${k} x${v}`);

const dateRows = [];
for (const a of audit) {
  let changes = [];
  try { changes = JSON.parse(a.fc); } catch { changes = []; }
  if (!Array.isArray(changes)) changes = [];
  const hits = changes.filter((c) => DATE_FIELD.test(String(c?.field ?? "")));
  if (hits.length > 0 || /status/i.test(a.action)) dateRows.push({ a, hits });
}
notice(`   rows naming a processing / delivery date or status: ${dateRows.length} on ${new Set(dateRows.map((r) => r.a.doc)).size} docs`);
for (const { a, hits } of dateRows) {
  say(`   ${a.doc} ${a.at.slice(0, 16)} ${a.action} [${a.source}] ${a.actor} :: ${hits.map((c) => `${c.field} ${JSON.stringify(c.from ?? null)} -> ${JSON.stringify(c.to ?? null)}`).join("; ")}${a.note ? ` · ${a.note}` : ""}`);
}

const st = await sql`
  SELECT doc_no, created_at::text AS at, coalesce(from_status, '') AS f, to_status AS t, coalesce(left(notes, 80), '') AS n
    FROM scm.mfg_so_status_changes WHERE doc_no = ANY(${DOCS}) AND created_at >= ${SINCE}::date ORDER BY created_at`;
notice(`3. status changes since ${SINCE}: ${st.length} on ${new Set(st.map((s) => s.doc_no)).size} docs · ${JSON.stringify(tally(st, (s) => `${s.f}->${s.t}`))}`);
for (const s of st) say(`   ${s.doc_no} ${s.at.slice(0, 16)} ${s.f} -> ${s.t} ${s.n}`);

notice("4. header updated_at day vs the audit actions written that day");
const auditOn = new Map();
for (const a of audit) auditOn.set(`${a.doc}|${a.day}`, [...(auditOn.get(`${a.doc}|${a.day}`) ?? []), `${a.action}[${a.source}]`]);
const upd = {};
for (const h of heads) {
  const acts = auditOn.get(`${h.doc_no}|${h.updated}`);
  const k = `${h.updated} ${acts ? [...new Set(acts)].sort().join("+") : "(no audit row that day)"}`;
  upd[k] = (upd[k] || 0) + 1;
}
for (const [k, v] of Object.entries(upd).sort()) say(`   ${k}: ${v}`);

const lines = await sql`
  SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n,
         count(*) FILTER (WHERE line_delivery_date IS NOT NULL)::int AS dated
    FROM scm.mfg_sales_order_items WHERE doc_no = ANY(${DOCS}) AND NOT cancelled GROUP BY 1 ORDER BY 1`;
notice(`5. live lines by created day: ${lines.map((l) => `${l.day} ${l.n} (${l.dated} dated)`).join(" · ")}`);

notice("READ-ONLY — nothing was written.");
await sql.end();
