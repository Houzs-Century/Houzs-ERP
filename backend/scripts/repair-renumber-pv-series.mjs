#!/usr/bin/env node
/* Re-order one month's FORMAL payment-voucher series by voucher date.

   Why (docs/bugs/0653, owner 2026-09-07): batch Check stamped the formal
   numbers in TICK order — with the list sorted newest-first, the 28/04
   vouchers took 2990-HPV-2604-001/002 and the 21/04 ones 003–006. The batch
   now sorts by voucher date before it runs; this puts the papers already
   numbered back in date order.

   WHAT moves: the suffix of every voucher on the series — ordered by
   voucher_date, then created_at (the Draft order), then id — becomes
   001..N at the series' existing width. Nothing else about a voucher moves.
   Where the number was written as TEXT it is renamed too: the audit ledger's
   entity_doc_no and acc_supplier_advances.pv_number.

   REFUSES when any voucher on the series is POSTED/CANCELLED or has a journal
   (a printed, posted number is history — renumber only what nobody has booked
   against), when the series is empty, or when the suffixes are not the plain
   1..N block this script knows how to permute.

   Two-phase rename (via -T## temporaries) so the UNIQUE pv_number index is
   never crossed mid-way; everything in ONE transaction; verified on a fresh
   connection. RE-RUN: convergent — a series already in date order reports
   nothing to do.

   Env: DATABASE_URL, SERIES (e.g. 2990-HPV-2604), MODE=plan|apply,
   CONFIRM="RENUMBER PV SERIES" for apply. */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "RENUMBER PV SERIES";
const url = process.env.DATABASE_URL;
const SERIES = String(process.env.SERIES || "").trim();
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (!/^[A-Za-z0-9]+-[A-Za-z]*PV-\d{4}$/.test(SERIES)) {
  console.error(`SERIES must look like 2990-HPV-2604 (got "${SERIES}")`); process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

async function survey(sql) {
  const rows = await sql`
    SELECT id, pv_number, voucher_date, created_at, status, posted_at, payee_name, total_sen,
           (SELECT count(*)::int FROM scm.journal_entries j WHERE j.source_doc_no = p.pv_number) AS journals
    FROM scm.payment_vouchers p
    WHERE pv_number LIKE ${SERIES + "-%"}
    ORDER BY voucher_date, created_at, id`;
  return rows;
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}  series=${SERIES}`);
  const rows = await survey(sql);
  if (rows.length === 0) { note(`nothing to do — no voucher carries ${SERIES}-*`); process.exit(0); }

  const bad = rows.filter((r) => r.status !== "DRAFT" || r.posted_at || r.journals > 0);
  if (bad.length > 0) {
    for (const r of bad) console.error(`REFUSED: ${r.pv_number} is ${r.status}${r.posted_at ? ", posted" : ""}${r.journals ? `, ${r.journals} journal(s)` : ""} — renumber only what nobody has booked against`);
    process.exit(1);
  }
  const suffixes = rows.map((r) => r.pv_number.slice(SERIES.length + 1));
  const width = suffixes[0].length;
  const nums = suffixes.map((s) => Number(s)).sort((a, b) => a - b);
  const block = nums.every((n, i) => n === i + 1) && suffixes.every((s) => s.length === width && /^\d+$/.test(s));
  if (!block) { console.error(`REFUSED: suffixes ${suffixes.join(", ")} are not the plain 1..${rows.length} block`); process.exit(1); }

  const plan = rows.map((r, i) => ({ id: r.id, from: r.pv_number, to: `${SERIES}-${String(i + 1).padStart(width, "0")}`, date: fmt(r.voucher_date), payee: r.payee_name, sen: r.total_sen }));
  for (const p of plan) note(`${p.from} -> ${p.to}   ${p.date}  ${p.payee}  RM ${(Number(p.sen) / 100).toFixed(2)}${p.from === p.to ? "  (unchanged)" : ""}`);
  const moving = plan.filter((p) => p.from !== p.to);
  if (moving.length === 0) { note("nothing to do — the series is already in date order"); process.exit(0); }
  const audit = await sql`SELECT count(*)::int AS n FROM scm.entity_audit_log WHERE entity_doc_no = ANY(${moving.map((p) => p.from)})`;
  const adv = await sql`SELECT count(*)::int AS n FROM scm.acc_supplier_advances WHERE pv_number = ANY(${moving.map((p) => p.from)})`;
  note(`${moving.length} voucher(s) move; text carrying those numbers: audit rows ${audit[0].n}, supplier advances ${adv[0].n}`);
  if (!APPLY) { note("PLAN complete — nothing written."); process.exit(0); }

  await sql.begin(async (tx) => {
    /* Phase 1: every moving voucher onto a temporary number (unique, never a real one). */
    for (const [i, p] of moving.entries()) {
      const tmp = `${SERIES}-T${String(i + 1).padStart(2, "0")}`;
      const r = await tx`UPDATE scm.payment_vouchers SET pv_number = ${tmp} WHERE id = ${p.id} AND pv_number = ${p.from}`;
      if (r.count !== 1) throw new Error(`phase 1: ${p.from} not found on its row any more`);
    }
    /* Phase 2: temporaries onto the final numbers; the text mirrors follow. */
    for (const [i, p] of moving.entries()) {
      const tmp = `${SERIES}-T${String(i + 1).padStart(2, "0")}`;
      const r = await tx`UPDATE scm.payment_vouchers SET pv_number = ${p.to} WHERE id = ${p.id} AND pv_number = ${tmp}`;
      if (r.count !== 1) throw new Error(`phase 2: temporary for ${p.from} not found`);
    }
    for (const p of moving) {
      await tx`UPDATE scm.entity_audit_log SET entity_doc_no = ${p.to + "#pending"} WHERE entity_doc_no = ${p.from}`;
      await tx`UPDATE scm.acc_supplier_advances SET pv_number = ${p.to + "#pending"} WHERE pv_number = ${p.from}`;
    }
    for (const p of moving) {
      await tx`UPDATE scm.entity_audit_log SET entity_doc_no = ${p.to} WHERE entity_doc_no = ${p.to + "#pending"}`;
      await tx`UPDATE scm.acc_supplier_advances SET pv_number = ${p.to} WHERE pv_number = ${p.to + "#pending"}`;
    }
  });
  note("written; verifying on a fresh connection");
  await sql.end({ timeout: 5 });
  const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const after = await survey(check);
  const pending = await check`SELECT count(*)::int AS n FROM scm.entity_audit_log WHERE entity_doc_no LIKE ${"%#pending"}`;
  await check.end({ timeout: 5 });
  const inOrder = after.every((r, i) => r.pv_number === `${SERIES}-${String(i + 1).padStart(width, "0")}`);
  const sameIds = after.map((r) => r.id).join(",") === plan.map((p) => p.id).join(",");
  note(`verify: ${after.length} voucher(s), in date order = ${inOrder}, same vouchers = ${sameIds}, dangling temporaries = ${pending[0].n}`);
  if (!inOrder || !sameIds || pending[0].n !== 0) { console.error("VERIFICATION FAILED"); process.exit(1); }
  note("APPLIED and verified on a fresh connection.");
  process.exit(0);
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}
