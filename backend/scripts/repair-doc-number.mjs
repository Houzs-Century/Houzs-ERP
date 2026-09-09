#!/usr/bin/env node
/* Move ONE finance document onto the number it should have carried.

   Why this exists (owner 2026-09-07: 为什么是2609? 你应该根据我放的日期): until
   that day every series took its YYMM from the day the row was keyed, so an AP
   invoice dated 31/03/2026 was minted 2990-API-2609-001. The mint now follows
   the document date; the one paper already issued under the wrong month is
   moved by hand — here — and nothing else about it changes.

   What moves, and only what moves:
     • the document's own number column;
     • its journal entries' source_doc_no (the engine finds a document's entry
       by that column — reverse/edit would otherwise post against nothing);
     • the number where it was written into narration / line notes / the audit
       ledger's entity_doc_no, as TEXT (replace, not re-derive);
     • the FROM series' counter row is DELETED when no other document remains
       on that series, so the next paper of that month self-seeds from the live
       max and no hole is left (the owner's ask: 不然 9 月下一张会变成 002).
   Refuses when TO already exists, when FROM is not exactly one row, or when
   TO's month prefix would collide with a higher live suffix.

   Env: DATABASE_URL, TABLE (whitelist below), FROM_NO, TO_NO,
   MODE=plan (default) | apply, CONFIRM="RENUMBER DOCUMENT" for apply.
   RE-RUN: convergent — once FROM is gone the plan reports nothing to do. */
import postgres from "postgres";

const DOCS = {
  ap_invoices:         { col: "invoice_number", sourceTypes: ["API", "API_REVERSAL"] },
  payment_vouchers:    { col: "pv_number",      sourceTypes: ["PV", "PV_REVERSAL"] },
  acc_receipts:        { col: "receipt_number", sourceTypes: ["RCT", "RCT_REVERSAL"] },
  acc_debtor_bills:    { col: "bill_number",    sourceTypes: ["ODB", "ODB_REVERSAL"] },
  acc_debtor_receipts: { col: "receipt_number", sourceTypes: ["ODR", "ODR_REVERSAL"] },
};

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "RENUMBER DOCUMENT";
const url = process.env.DATABASE_URL;
const table = String(process.env.TABLE || "").trim();
const FROM = String(process.env.FROM_NO || "").trim();
const TO = String(process.env.TO_NO || "").trim();
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (!DOCS[table]) { console.error(`TABLE must be one of: ${Object.keys(DOCS).join(", ")} (got "${table}")`); process.exit(2); }
if (!/^[A-Za-z0-9-]{6,60}$/.test(FROM) || !/^[A-Za-z0-9-]{6,60}$/.test(TO) || FROM === TO) {
  console.error("FROM_NO / TO_NO must be two different document numbers (letters, digits, dashes)."); process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const { col, sourceTypes } = DOCS[table];
const seriesOf = (no) => no.slice(0, no.lastIndexOf("-"));
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Everything the plan reports and the apply touches — one shape, read on a
   fresh connection afterwards so the verification is not the writer's cache. */
async function survey(sql) {
  const docs = await sql.unsafe(`SELECT id, company_id, "${col}" AS no FROM scm."${table}" WHERE "${col}" = $1`, [FROM]);
  const taken = await sql.unsafe(`SELECT id FROM scm."${table}" WHERE "${col}" = $1`, [TO]);
  const jes = await sql`SELECT id, je_no, source_type, entry_date FROM scm.journal_entries
                        WHERE source_doc_no = ${FROM} AND source_type = ANY(${sourceTypes}) ORDER BY entry_date, je_no`;
  const narr = await sql`SELECT count(*)::int AS n FROM scm.journal_entries WHERE narration LIKE ${"%" + FROM + "%"}`;
  const notes = await sql`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE notes LIKE ${"%" + FROM + "%"}`;
  const audit = await sql`SELECT count(*)::int AS n FROM scm.entity_audit_log WHERE entity_doc_no = ${FROM}`;
  const fromSeries = seriesOf(FROM);
  const toSeries = seriesOf(TO);
  const othersOnFrom = await sql.unsafe(
    `SELECT count(*)::int AS n FROM scm."${table}" WHERE "${col}" LIKE $1 AND "${col}" <> $2`, [fromSeries + "-%", FROM]);
  const liveMaxOnTo = await sql.unsafe(
    `SELECT max("${col}") AS mx FROM scm."${table}" WHERE "${col}" LIKE $1`, [toSeries + "-%"]);
  const counters = await sql`SELECT series, next_n FROM scm.doc_number_counters WHERE series IN (${fromSeries}, ${toSeries})`;
  return {
    docs, taken, jes, narr: narr[0].n, notes: notes[0].n, audit: audit[0].n,
    fromSeries, toSeries, othersOnFrom: othersOnFrom[0].n, liveMaxOnTo: liveMaxOnTo[0].mx, counters,
  };
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}  table=${table}  ${FROM} -> ${TO}`);
  const s = await survey(sql);
  if (s.docs.length === 0) { note(`nothing to do — no ${table} row carries ${FROM} (already moved?)`); process.exit(0); }
  if (s.docs.length > 1) { console.error(`REFUSED: ${s.docs.length} rows carry ${FROM}`); process.exit(1); }
  if (s.taken.length > 0) { console.error(`REFUSED: ${TO} already exists on ${table}`); process.exit(1); }
  if (s.liveMaxOnTo && String(s.liveMaxOnTo) > TO) {
    console.error(`REFUSED: ${s.toSeries} already runs past ${TO} (live max ${s.liveMaxOnTo}) — pick the next free suffix`); process.exit(1);
  }
  const d = s.docs[0];
  note(`document: ${table} id=${d.id} co${d.company_id} ${d.no}`);
  for (const j of s.jes) note(`journal: ${j.je_no} (${j.source_type}, ${fmt(j.entry_date)}) source_doc_no -> ${TO}`);
  note(`text carrying the number: narration ${s.narr}, line notes ${s.notes}, audit rows ${s.audit}`);
  note(`series ${s.fromSeries}: other documents still on it = ${s.othersOnFrom}; counters: ${JSON.stringify(s.counters)}`);
  const dropFromCounter = s.othersOnFrom === 0 && s.counters.some((c) => c.series === s.fromSeries);
  note(dropFromCounter
    ? `counter ${s.fromSeries} will be DELETED so the next paper of that month self-seeds from the live max (no hole)`
    : `counter ${s.fromSeries} stays (other documents remain on the series, or no counter row)`);
  if (!APPLY) { note("PLAN complete — nothing written."); process.exit(0); }

  await sql.begin(async (tx) => {
    const r1 = await tx.unsafe(`UPDATE scm."${table}" SET "${col}" = $1 WHERE "${col}" = $2`, [TO, FROM]);
    if (r1.count !== 1) throw new Error(`document update touched ${r1.count} rows`);
    await tx`UPDATE scm.journal_entries SET source_doc_no = ${TO} WHERE source_doc_no = ${FROM} AND source_type = ANY(${sourceTypes})`;
    await tx`UPDATE scm.journal_entries SET narration = replace(narration, ${FROM}, ${TO}) WHERE narration LIKE ${"%" + FROM + "%"}`;
    await tx`UPDATE scm.journal_entry_lines SET notes = replace(notes, ${FROM}, ${TO}) WHERE notes LIKE ${"%" + FROM + "%"}`;
    await tx`UPDATE scm.entity_audit_log SET entity_doc_no = ${TO} WHERE entity_doc_no = ${FROM}`;
    if (dropFromCounter) await tx`DELETE FROM scm.doc_number_counters WHERE series = ${s.fromSeries}`;
  });
  note("written; verifying on a fresh connection");
  await sql.end({ timeout: 5 });
  const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const after = await survey(check);
  const moved = await check.unsafe(`SELECT count(*)::int AS n FROM scm."${table}" WHERE "${col}" = $1`, [TO]);
  const jeOnTo = await check`SELECT count(*)::int AS n FROM scm.journal_entries WHERE source_doc_no = ${TO} AND source_type = ANY(${sourceTypes})`;
  await check.end({ timeout: 5 });
  const clean = after.docs.length === 0 && after.jes.length === 0 && after.narr === 0 && after.notes === 0 && after.audit === 0
    && moved[0].n === 1 && jeOnTo[0].n === s.jes.length
    && (!dropFromCounter || !after.counters.some((c) => c.series === s.fromSeries));
  note(`verify: FROM left ${after.docs.length + after.jes.length + after.narr + after.notes + after.audit} trace(s); ${TO} on ${moved[0].n} document, ${jeOnTo[0].n} journal(s)`);
  if (!clean) { console.error("VERIFICATION FAILED"); process.exit(1); }
  note("APPLIED and verified on a fresh connection.");
  process.exit(0);
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}

function fmt(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}
