#!/usr/bin/env node
// Dump a purchase order to a RESTORABLE JSON file, then — only when asked for
// by name — delete it.
//
// WHY THIS EXISTS. The owner's standing rule is cancel, never delete; he
// reaffirmed「真的删掉」for exactly one document, HC-PO-009944, whose AutoCount
// original was hard-deleted in the book (the PO DtlKey sequence skips 905144
// and 905146 and the ERP row holds exactly those two — the deletion
// fingerprint diag-ac-four-exceptions.mjs measures). A cancelled row would
// keep claiming an AutoCount number the book does not have, so the reconcile
// would keep counting it as a phantom forever.
//
// THE DUMP IS THE PRECONDITION, NOT A COURTESY. MODE=delete refuses unless the
// dump file has been written AND read back and re-parsed on this run. The file
// is the only copy of the row once the DELETE commits, so "I wrote it" is not
// evidence — "I read it back" is.
//
// WHAT IT REFUSES TO DELETE. Every refusal is a MEASUREMENT, printed with its
// number, never a silent skip:
//   - the po_number matches anything other than exactly one header
//   - any row in any table anywhere in the database points at the header or at
//     one of its lines (discovered from pg_constraint, so a table nobody
//     remembers still blocks the delete). ON DELETE CASCADE children are
//     listed as CASCADE and do not block — they are dumped too.
//   - total_sen is not 0
//   - any line carries received_qty > 0
// Those four are the whole safety property: a document that cost money, moved
// stock, or is referenced by another document is not a phantom.
//
// READ THE DUMP PATH OUT OF THE LOG. The JSON is printed to stdout in full as
// well as written to OUT, because a workflow artifact expires and a log line
// does not.
//
// RESTORE: the dump's `restore` block carries INSERT statements generated from
// the rows themselves. It is not run from here; restoring is a separate,
// deliberate act.
//
// MODE=dump (default) | MODE=delete, and delete also needs
//   CONFIRM="DELETE <PO_NUMBER>"
// PO_NUMBER=HC-PO-009944  OUT=/tmp/po-dump.json  COMPANY_ID=1
//
// RE-RUN: inert after a delete — the header is gone, the script says so and
// exits 0 without writing.
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
const PO_NUMBER = (process.env.PO_NUMBER || "").trim();
const MODE = (process.env.MODE || "dump").toLowerCase();
const CONFIRM = process.env.CONFIRM || "";
const CO = Number(process.env.COMPANY_ID || 1);
const OUT = process.env.OUT || path.join(process.cwd(), `po-dump-${PO_NUMBER || "unknown"}.json`);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!PO_NUMBER) { console.error("REFUSED: PO_NUMBER not set."); process.exit(2); }
if (!["dump", "delete"].includes(MODE)) { console.error(`MODE must be dump or delete, got ${MODE}`); process.exit(2); }
const DELETE = MODE === "delete";
if (DELETE && CONFIRM !== `DELETE ${PO_NUMBER}`) {
  console.error(`REFUSED: MODE=delete needs CONFIRM="DELETE ${PO_NUMBER}".`);
  process.exit(2);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* A value Postgres gave us, rendered as a SQL literal that reproduces it. */
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const insertFor = (table, row) => {
  const cols = Object.keys(row);
  return `INSERT INTO scm.${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`;
};

async function main() {
  log(`mode=${MODE} po=${PO_NUMBER} company=${CO} out=${OUT}`);

  const hdrRows = await sql`SELECT to_jsonb(p) AS j, p.id AS id FROM scm.purchase_orders p
    WHERE p.company_id = ${CO} AND p.po_number = ${PO_NUMBER}`;
  log(`headers matching po_number=${PO_NUMBER} in company ${CO}: ${hdrRows.length}`);
  if (hdrRows.length === 0) {
    log("nothing to do — no such purchase order. (After a delete this is the expected answer.)");
    await sql.end();
    return;
  }
  if (hdrRows.length !== 1) {
    log(`REFUSED: expected exactly 1 header, found ${hdrRows.length}. Nothing dumped, nothing deleted.`);
    await sql.end();
    process.exit(1);
  }

  const id = hdrRows[0].id;
  const header = hdrRows[0].j;
  const lineRows = await sql`SELECT to_jsonb(i) AS j, i.id AS id FROM scm.purchase_order_items i
    WHERE i.purchase_order_id = ${id} ORDER BY i.id`;
  const lines = lineRows.map((r) => r.j);
  const lineIds = lineRows.map((r) => r.id);
  log(`lines: ${lines.length}`);

  /* ── who points at this document?  Asked of pg_constraint, not of memory ──
     Every FK whose referenced table is purchase_orders or purchase_order_items
     is probed for rows carrying our id.  A table added next month is covered
     without anyone editing this script. */
  const fks = await sql`
    SELECT c.conname,
           src_ns.nspname  AS src_schema, src.relname  AS src_table,
           tgt.relname     AS tgt_table,
           c.confdeltype   AS del_action,
           (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS src_col
      FROM pg_constraint c
      JOIN pg_class src      ON src.oid = c.conrelid
      JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
      JOIN pg_class tgt      ON tgt.oid = c.confrelid
      JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
     WHERE c.contype = 'f' AND tgt_ns.nspname = 'scm'
       AND tgt.relname IN ('purchase_orders', 'purchase_order_items')
       AND array_length(c.confkey, 1) = 1`;

  const referrers = [];
  let blockers = 0;
  for (const fk of fks) {
    const ids = fk.tgt_table === "purchase_orders" ? [id] : lineIds;
    if (!ids.length) continue;
    /* ::text on both sides — scm's keys are uuid today and the legacy public
       tables are serial; a cast that works for both is one less thing to be
       wrong about than a hard-coded ::uuid[]. */
    const rows = await sql.unsafe(
      `SELECT to_jsonb(t) AS j FROM ${fk.src_schema}.${fk.src_table} t WHERE t."${fk.src_col}"::text = ANY($1::text[])`,
      [ids.map(String)]);
    if (!rows.length) continue;
    const cascade = fk.del_action === "c";
    referrers.push({ table: `${fk.src_schema}.${fk.src_table}`, column: fk.src_col,
                     references: fk.tgt_table, onDelete: cascade ? "CASCADE" : "RESTRICT",
                     count: rows.length, rows: rows.map((r) => r.j) });
    log(`  referenced by ${fk.src_schema}.${fk.src_table}.${fk.src_col} -> ${fk.tgt_table}: ${rows.length} row(s) [${cascade ? "CASCADE" : "BLOCKS"}]`);
    if (!cascade) blockers += rows.length;
  }
  if (!referrers.length) log("  referenced by: nothing, anywhere in the database");

  /* ── the money and stock tests ── */
  const totalSen = Number(header.total_sen ?? 0);
  const received = lines.reduce((a, l) => a + Number(l.received_qty ?? 0), 0);
  log(`total_sen: ${totalSen}; received_qty summed over lines: ${received}`);

  const dump = {
    dumpedAt: new Date().toISOString(),
    reason: "restorable dump taken immediately before DELETE",
    database: "production (secrets.DATABASE_URL)",
    companyId: CO,
    poNumber: PO_NUMBER,
    header,
    lines,
    referrers,
    measurements: { totalSen, receivedQtySum: received, blockingReferences: blockers },
    restore: [insertFor("purchase_orders", header), ...lines.map((l) => insertFor("purchase_order_items", l))],
  };
  const json = JSON.stringify(dump, null, 2);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, "utf8");

  /* READ IT BACK.  Writing is intent; parsing what came off the disk is
     evidence, and evidence is the precondition for the DELETE below. */
  const readBack = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const ok = readBack.poNumber === PO_NUMBER && readBack.lines.length === lines.length && !!readBack.header;
  log(`dump written to ${OUT} (${json.length} bytes) and re-read: ${ok ? "OK" : "FAILED"}`);
  plain("----- BEGIN RESTORABLE DUMP -----");
  plain(json);
  plain("----- END RESTORABLE DUMP -----");
  if (!ok) { log("REFUSED: the dump did not read back. Nothing deleted."); await sql.end(); process.exit(1); }

  if (!DELETE) {
    log(`DUMP ONLY — no writes. MODE=delete CONFIRM="DELETE ${PO_NUMBER}" deletes it.`);
    await sql.end();
    return;
  }

  if (blockers > 0) { log(`REFUSED: ${blockers} row(s) in other tables reference this document. Nothing deleted.`); await sql.end(); process.exit(1); }
  if (totalSen !== 0) { log(`REFUSED: total_sen is ${totalSen}, not 0. Nothing deleted.`); await sql.end(); process.exit(1); }
  if (received !== 0) { log(`REFUSED: received_qty sums to ${received}, not 0. Nothing deleted.`); await sql.end(); process.exit(1); }

  await sql.begin(async (tx) => {
    const di = await tx`DELETE FROM scm.purchase_order_items WHERE purchase_order_id = ${id} RETURNING id`;
    const dh = await tx`DELETE FROM scm.purchase_orders WHERE id = ${id} AND company_id = ${CO} RETURNING id`;
    log(`deleted ${di.length} line(s) and ${dh.length} header(s)`);
    if (dh.length !== 1) throw new Error(`expected to delete exactly 1 header, deleted ${dh.length} — rolled back`);
  });

  /* verification on a connection this run has not used */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const gone = await v`SELECT COUNT(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number = ${PO_NUMBER}`;
  const goneLines = await v`SELECT COUNT(*)::int AS n FROM scm.purchase_order_items WHERE purchase_order_id = ${id}`;
  log(`VERIFY on a fresh connection: headers remaining ${gone[0].n}, lines remaining ${goneLines[0].n}`);
  await v.end();
  await sql.end();
  if (gone[0].n !== 0 || goneLines[0].n !== 0) process.exit(1);
  log(`DONE. ${PO_NUMBER} deleted; the restorable dump is at ${OUT} and printed above.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
