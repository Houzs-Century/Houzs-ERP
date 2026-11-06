#!/usr/bin/env node
// Delete a TEST Purchase Order + the rows it owns. The PO twin of
// scripts/delete-test-so.mjs; read that file's header for the full reasoning.
//
// IT DOES NOT GIVE THE NUMBER BACK. scm.doc_number_counters only goes up, so
// the deleted number becomes a gap; the run reads the counter and says so. To
// reclaim it: scripts/reclaim-doc-no.mjs (Actions -> "Reclaim a document number").
//
// SAFETY:
//   - MODE=plan by default: prints every row it would touch AND the full content
//     of the PO and its children, and writes nothing. MODE=apply deletes
//     (APPLY=1 is the same thing). Apply also needs CONFIRM_DOC == DOC_NO.
//   - REFUSES unless the PO is DRAFT or CANCELLED. A SUBMITTED PO claims SO
//     quota and sits in AutoCount; cancelling it in the app undoes both.
//   - REFUSES if AutoCount holds the PO and no cancel was sent, or if any
//     outbox row for it is still pending / failed.
//   - SWEEPS THE LIVE SCHEMA for every column that names the PO's number, its
//     uuid or one of its lines' uuids, and REFUSES on a GRN, invoice, return,
//     stock movement, DO, journal or any reference nobody has classified.
//   - A product request linked to the PO keeps living; its po_id is cleared
//     (listed by id in the plan). Owner's ruling, 5 Nov 2026.
//   - One transaction; nothing writes unless everything succeeds.
//   - VERIFIES ON A FRESH CONNECTION: the PO and its children gone, the audit
//     trail still there, and a CONTROL proving no OTHER purchase order moved.
//
// EXIT CODE: 0 for every legitimate answer, including a refusal. Only an
// unreachable DB, a failed transaction or a failed verification exits non-zero.
//
// Usage:  DOC_NO=HC-PO-2611-001 [CONFIRM_DOC=… MODE=apply] node scripts/delete-test-po.mjs
//
// RE-RUN: inert. A second apply finds nothing and says so.
//
// THERE IS NO UNDO; THE RECOVERY PATH IS THE RUN LOG. Before any write this
// prints the header and every child row as complete JSON.
import postgres from "postgres";
import {
  AUDIT, AUDIT_KEEP, CHILD, CHILD_TABLES, DOWNSTREAM, UNCLASSIFIED, UNLINK, UNLINK_TABLES,
  bindMatch, classifyReference, controlDrift, controlSnapshot, poBlockers, sweepReferences,
} from "./lib/delete-test-po-refs.mjs";

const DST = process.env.DATABASE_URL;
const DOC_NO = (process.env.DOC_NO ?? "").trim();
const CONFIRM_DOC = (process.env.CONFIRM_DOC ?? "").trim();
const MODE = (process.env.MODE || (process.env.APPLY === "1" ? "apply" : "plan")).trim().toLowerCase();
if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be "plan" or "apply"; got ${JSON.stringify(process.env.MODE)}`);
  process.exit(2);
}
const APPLY = MODE === "apply";
/* An unclassified reference stops the run. Set this to leave those rows in
   place as orphans and delete anyway — a deliberate, named act. */
const ALLOW_ORPHAN_REFS = process.env.ALLOW_ORPHAN_REFS === "yes";

if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!DOC_NO) { console.error("need DOC_NO env (e.g. HC-PO-2611-001)"); process.exit(2); }

const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

const exists = async (client, t) => Boolean((await client.unsafe(`SELECT to_regclass('${t}') AS t`))[0].t);

async function main() {
  console.log(`\n== delete-test-po :: DOC_NO=${DOC_NO} MODE=${MODE} ==\n`);

  if (APPLY && CONFIRM_DOC !== DOC_NO) {
    refuse(
      `CONFIRM_DOC must repeat the PO number exactly to apply. ` +
      `Got DOC_NO="${DOC_NO}" CONFIRM_DOC="${CONFIRM_DOC || "(empty)"}".`,
    );
  }

  // (1) The parent row. `_R1` style numbers are display-only; the row holds the bare number.
  const found = await db`SELECT * FROM scm.purchase_orders WHERE po_number = ${DOC_NO}`;
  if (found.length === 0) {
    console.log(`PO ${DOC_NO} NOT FOUND. Nothing to delete. (Type the number without any _R suffix.)`);
    return;
  }
  if (found.length > 1) refuse(`${found.length} purchase orders carry po_number ${DOC_NO}. Not touching any of them.`);
  const po = found[0];
  console.log(`Parent  : ${DOC_NO}  id=${po.id}  status=${po.status}  company_id=${po.company_id ?? "—"}  linked_ac_docno=${po.linked_ac_docno ?? "—"}`);
  const lineIds = (await db`SELECT id::text AS id FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id}`)
    .map((r) => r.id);

  // Resolve which child tables are in this database, once.
  const children = [];
  for (const t of CHILD_TABLES) {
    if (await exists(db, t.table)) children.push(t);
    else console.log(`Child   : ${t.table.padEnd(40)} (table absent — skip)`);
  }
  const countIn = async (client, t) => {
    const { text, params } = bindMatch(t.match, po);
    return (await client.unsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${text}`, params))[0].n;
  };

  // (1b) THE RECOVERY PATH — every column of the header and every child row.
  const capture = { header: [po] };
  for (const t of children) {
    const { text, params } = bindMatch(t.match, po);
    capture[t.table] = await db.unsafe(`SELECT * FROM ${t.table} WHERE ${text}`, params);
  }
  console.log("");
  console.log(`CONTENT OF ${DOC_NO} — the complete record, printed BEFORE any write.`);
  console.log("If a ruling is reversed, this JSON is what the document is re-keyed from.");
  console.log("---8<--- capture begin ---8<---");
  console.log(JSON.stringify(capture, null, 2));
  console.log("---8<--- capture end ---8<---");
  console.log("");

  // (2) Live? Status and AutoCount.
  const blockers = await poBlockers(db, po);
  for (const b of blockers) console.log(`LIVE    : ${b}`);
  if (blockers.length > 0) refuse(`${blockers.length} reason(s) this PO is still live — see the LIVE lines above.`);

  // (2b) THE SWEEP. Who else names this PO or its lines?
  const sweep = await sweepReferences(db, po, lineIds);
  console.log("");
  console.log(`REFERENCE SWEEP — ${sweep.scanned} candidate columns, ${lineIds.length} line id(s)`);
  for (const f of sweep.failed) console.log(`  UNREADABLE  ${f.table}.${f.column}  ${f.why}`);
  if (sweep.hits.length === 0) console.log(`  nothing anywhere in the database names ${DOC_NO}`);
  const LEGEND = {
    [CHILD]: "CHILD        — deleted with the PO",
    [AUDIT]: "AUDIT        — deliberately KEPT (append-only record)",
    [DOWNSTREAM]: "DOWNSTREAM   — a real document / stock / money; this REFUSES",
    [UNLINK]: "UNLINK       — the row stays, its link to this PO is cleared",
    [UNCLASSIFIED]: "UNCLASSIFIED — nobody has said what this is",
  };
  const orphans = [];
  const downstream = [];
  for (const h of sweep.hits) {
    const kind = classifyReference(h.table);
    console.log(`  ${String(h.n).padStart(5)} row(s)  ${`${h.table}.${h.column}`.padEnd(52)} ${LEGEND[kind]}`);
    if (kind === UNCLASSIFIED) orphans.push(h);
    if (kind === DOWNSTREAM) downstream.push(h);
  }
  console.log("");
  if (downstream.length > 0) {
    refuse(`${downstream.map((h) => `${h.table}.${h.column} (${h.n})`).join(", ")} reference ${DOC_NO}. That is a real downstream record.`);
  }
  if (sweep.failed.length > 0) {
    refuse(`${sweep.failed.length} column(s) could not be counted. A count that did not run is not a zero.`);
  }
  if (orphans.length > 0 && !ALLOW_ORPHAN_REFS) {
    refuse(
      `${orphans.length} reference(s) nobody has classified: ` +
      orphans.map((h) => `${h.table}.${h.column} (${h.n})`).join(", ") +
      ". Classify them in CHILD_TABLES / AUDIT_KEEP / DOWNSTREAM_TABLES (lib/delete-test-po-refs.mjs), " +
      "or re-run with ALLOW_ORPHAN_REFS=yes to leave them behind on purpose.",
    );
  }
  if (orphans.length > 0) {
    console.log(`ALLOW_ORPHAN_REFS=yes — ${orphans.length} unclassified reference(s) will be LEFT BEHIND as orphans.`);
    console.log("");
  }

  // (3) What will be deleted, and every row whose link to the PO will be cleared.
  for (const t of children) console.log(`Child   : ${t.table.padEnd(40)} rows=${await countIn(db, t)}`);
  const unlinks = [];
  for (const u of UNLINK_TABLES) {
    if (!(await exists(db, u.table))) { console.log(`Unlink  : ${u.table.padEnd(40)} (table absent — skip)`); continue; }
    const rows = await db.unsafe(`SELECT id::text AS id FROM ${u.table} WHERE "${u.column}" = $1::uuid ORDER BY id`, [String(po.id)]);
    unlinks.push(u);
    console.log(`Unlink  : ${`${u.table}.${u.column}`.padEnd(40)} rows=${rows.length}${rows.length ? "  " + rows.map((r) => r.id).join(" ") : ""}`);
  }

  // (4) THE CONTROL — every OTHER purchase order, before and after.
  const [moneyRow] = await db`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'purchase_orders' AND column_name = 'total_sen'`;
  const moneyCol = moneyRow ? "total_sen" : null;
  const control = (client) => controlSnapshot(client, po.id, { moneyCol });
  const beforeCtl = await control(db);
  console.log("");
  console.log("CONTROL (every purchase order EXCEPT this one) — BEFORE");
  console.log(`  pos=${beforeCtl.po_rows}  lines=${beforeCtl.item_rows}  total_sen=${beforeCtl.money_sum ?? "n/a"}  fingerprint=${beforeCtl.po_fingerprint}`);
  console.log("");

  if (!APPLY) {
    console.log("PLAN complete. Nothing was written.");
    console.log(`To actually delete: MODE=apply CONFIRM_DOC=${DOC_NO}`);
    return;
  }

  // (5) One transaction.
  await db.begin(async (sql) => {
    for (const u of unlinks) {
      const r = await sql.unsafe(`UPDATE ${u.table} SET "${u.column}" = NULL WHERE "${u.column}" = $1::uuid`, [String(po.id)]);
      console.log(`Unlinked: ${`${u.table}.${u.column}`.padEnd(40)} rows=${r.count}`);
    }
    for (const t of children) {
      const { text, params } = bindMatch(t.match, po);
      const r = await sql.unsafe(`DELETE FROM ${t.table} WHERE ${text}`, params);
      console.log(`Deleted : ${t.table.padEnd(40)} rows=${r.count}`);
    }
    const r = await sql`DELETE FROM scm.purchase_orders WHERE id = ${po.id}`;
    console.log(`Deleted : ${"scm.purchase_orders".padEnd(40)} rows=${r.count}`);
    if (r.count !== 1) throw new Error(`expected to delete exactly 1 PO row, deleted ${r.count} — rolled back`);
  });

  // (6) AFTER-STATE PROOF, ON A FRESH CONNECTION. A mismatch exits 1.
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const shape = [];
  try {
    const [check] = await verify`SELECT count(*)::int AS n FROM scm.purchase_orders WHERE id = ${po.id}`;
    console.log(`\nAfter (fresh connection):`);
    console.log(`  parent ${DOC_NO} rows=${check.n}  ${check.n === 0 ? "gone" : "STILL PRESENT"}`);
    if (check.n !== 0) shape.push(`the parent row is still present (${check.n})`);
    for (const t of children) {
      const n = await countIn(verify, t);
      console.log(`  ${t.table.padEnd(40)} rows=${n}`);
      if (n !== 0) shape.push(`${t.table} still has ${n} row(s)`);
    }
    const after = await sweepReferences(verify, po, lineIds);
    console.log(`  reference sweep: ${after.hits.length} column(s) still name ${DOC_NO} or its lines`);
    for (const h of after.hits) {
      const kept = AUDIT_KEEP.has(h.table);
      console.log(`    ${String(h.n).padStart(5)}  ${h.table}.${h.column}  ${kept ? "AUDIT — kept on purpose" : "UNEXPECTED"}`);
      if (!kept && !ALLOW_ORPHAN_REFS) shape.push(`${h.table}.${h.column} still names the deleted PO`);
    }
    if (after.failed.length) shape.push(`${after.failed.length} column(s) could not be re-read`);

    const afterCtl = await control(verify);
    console.log("  CONTROL (every purchase order EXCEPT this one) — AFTER");
    console.log(`    pos=${afterCtl.po_rows}  lines=${afterCtl.item_rows}  total_sen=${afterCtl.money_sum ?? "n/a"}  fingerprint=${afterCtl.po_fingerprint}`);
    for (const k of controlDrift(beforeCtl, afterCtl)) {
      shape.push(`CONTROL ${k} moved: ${beforeCtl[k]} -> ${afterCtl[k]} — another PO changed`);
    }
    if (shape.length === 0) {
      console.log("  SHAPE OK: the PO and its children are gone, the audit trail is intact,");
      console.log("  and every other purchase order is unchanged.");
    }
  } finally {
    await verify.end();
  }
  if (shape.length > 0) throw new Error(`VERIFICATION FAILED — ${shape.join("; ")}`);

  // (7) What the next save will actually take. Read the counter, do not reason about it.
  const prefix = DOC_NO.replace(/\d+$/, "%");
  const [maxRow] = await db.unsafe(
    `SELECT po_number FROM scm.purchase_orders WHERE po_number LIKE $1 ORDER BY po_number DESC LIMIT 1`,
    [prefix],
  );
  const liveMax = Number(/(\d+)$/.exec(maxRow?.po_number ?? "")?.[1] ?? 0);
  console.log(`Highest ${prefix} now : ${maxRow?.po_number ?? "(none)"}`);
  const series = DOC_NO.replace(/-\d+$/, "");
  if (!(await exists(db, "scm.doc_number_counters"))) {
    console.log(`Counter : scm.doc_number_counters ABSENT — the next mint is max+1.`);
    return;
  }
  const [counter] = await db`SELECT next_n FROM scm.doc_number_counters WHERE series = ${series}`;
  if (!counter) {
    console.log(`Counter : no row for series ${series} — it self-seeds from the live max, so the next mint reclaims ${DOC_NO}.`);
    return;
  }
  const nextSuffix = Math.max(Number(counter.next_n), liveMax + 1);
  const nextDocNo = `${series}-${String(nextSuffix).padStart(3, "0")}`;
  console.log(`Counter : ${series} next_n=${counter.next_n} — the NEXT save will take ${nextDocNo}.`);
  if (nextDocNo !== DOC_NO) {
    console.log(`WARNING : ${DOC_NO} is now a PERMANENT GAP. The counter only ever goes up.`);
    console.log(`WARNING : To hand it back:  SERIES=${series} TARGET_N=${Number(/(\d+)$/.exec(DOC_NO)[1])} node scripts/reclaim-doc-no.mjs`);
    console.log(`WARNING : (or Actions -> "Reclaim a document number"). It refuses unless the number is genuinely free.`);
  }
}

main().then(() => db.end()).catch(async (e) => {
  if (e instanceof Refused) {
    console.log(`\nREFUSED: ${e.message}`);
    console.log("Nothing was written. This is a verdict, not a failure.");
    await db.end();
    return;
  }
  console.error("DELETE_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
