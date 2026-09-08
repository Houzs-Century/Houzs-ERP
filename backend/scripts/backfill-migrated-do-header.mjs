// Fill in the customer / delivery header the migrated delivery-order writer
// never copied: address, phone, email, salesperson, delivery date and the rest
// of the SO header snapshot on scm.delivery_orders.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
// create-migrated-documents.mjs wrote a DO header with twelve columns —
// number, SO link, debtor code/name, status, date, currency, company, author,
// note, the migrated flag and the AutoCount doc number. The UI writer
// (POST /delivery-orders-mfg/from-sos) snapshots the WHOLE SO header onto the
// DO: address1/2, city, state, postcode, phone, email, salesperson, agent,
// customer type, building type, branding, venue, ref, sales location, the
// emergency contact and the customer delivery date. The migrated writer copied
// none of them, so every AutoCount-mirrored DO opens with Phone / Email /
// Address / Salesperson / Delivery date all "—", and prints the same way.
// Staff noticed on HC-DO-011559 (2026-09-08).
//
// ── WHAT THIS FILLS FROM ───────────────────────────────────────────────────
// A delivery order is a SNAPSHOT OF THE SALES ORDER AT DISPATCH, so the parent
// is delivery_orders.so_doc_no -> mfg_sales_orders.doc_no, and the mapping is
// the one the UI writer applies (backend/src/scm/lib/so-to-do-fields.ts):
// address2 falls back to address3 + address4, `state` mirrors customer_state,
// phones are stored in E.164, expected_delivery_at falls back to the DO date.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//   · It never overwrites a stated value. Every column is guarded by its own
//     IS NULL at write time, so a header a human already corrected keeps that
//     correction even where it disagrees with the SO.
//   · It writes no inventory movement, no status, no money column.
//   · Where the SO itself is blank on a field, the DO stays blank and the plan
//     SAYS SO — that is an SO-side gap for the AutoCount ledger, not something
//     to invent here.
//
// SCOPE=migrated (default) restricts to delivery_orders.migrated_no_stock =
// true — the documents this writer made. SCOPE=all covers every DO in the
// company whose header still has a NULL the SO can fill. DRY-RUN by default;
// APPLY=1 writes. DO=HC-DO-011559 limits the plan to one document.
import postgres from "postgres";
import {
  DO_HEADER_SNAPSHOT_COLS, SO_HEADER_SNAPSHOT_COLS, soHeaderToDoSnapshot,
} from "./lib/migrated-do-header-snapshot.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const SCOPE = (process.env.SCOPE || "migrated").toLowerCase();
const CAP = Number(process.env.CAP || 40);
const ONLY_DO = (process.env.DO || "").trim() || null;
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const MIGRATED_ONLY = SCOPE !== "all";
const SCOPED = MIGRATED_ONLY ? sql`AND d.migrated_no_stock = true` : sql``;
const ONE = ONLY_DO ? sql`AND d.do_number = ${ONLY_DO}` : sql``;

const short = (v) => (v == null ? "-" : String(v).replace(/\s+/g, " ").slice(0, 60));

/* The mapping is lib/migrated-do-header-snapshot.mjs — the SAME one the writer
   applies to a new document — so a backfilled header is indistinguishable from
   one written correctly on day one. sales_location is deliberately not in it. */
const DO_COLS = DO_HEADER_SNAPSHOT_COLS;
const SO_COLS = SO_HEADER_SNAPSHOT_COLS;

async function columnsOf(table) {
  return (await sql`SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}`).map((c) => c.column_name);
}

async function survey(label) {
  const [r] = await sql`
    SELECT COUNT(*)::int AS docs,
           COUNT(*) FILTER (WHERE d.address1 IS NULL)::int       AS addr_null,
           COUNT(*) FILTER (WHERE d.phone IS NULL)::int          AS phone_null,
           COUNT(*) FILTER (WHERE d.email IS NULL)::int          AS email_null,
           COUNT(*) FILTER (WHERE d.salesperson_id IS NULL)::int AS sp_null,
           COUNT(*) FILTER (WHERE d.customer_delivery_date IS NULL)::int AS cdd_null
      FROM scm.delivery_orders d
     WHERE d.company_id = ${CO} ${SCOPED} ${ONE}`;
  log(`   ${label}: ${r.docs} DO(s) in scope · address1 NULL ${r.addr_null} · phone NULL ${r.phone_null}` +
      ` · email NULL ${r.email_null} · salesperson NULL ${r.sp_null} · customer_delivery_date NULL ${r.cdd_null}`);
  return r;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} scope=${MIGRATED_ONLY ? "migrated documents only" : "ALL delivery orders"}${ONLY_DO ? ` do=${ONLY_DO}` : ""}`);

  const doCols = await columnsOf("delivery_orders");
  const soCols = await columnsOf("mfg_sales_orders");
  const missDo = DO_COLS.filter((c) => !doCols.includes(c));
  const missSo = SO_COLS.filter((c) => !soCols.includes(c));
  if (missDo.length || missSo.length) {
    log(`REFUSING — schema differs from what this script was written against:` +
        `${missDo.length ? ` delivery_orders lacks ${missDo.join(", ")}.` : ""}` +
        `${missSo.length ? ` mfg_sales_orders lacks ${missSo.join(", ")}.` : ""}`);
    await sql.end(); return;
  }
  log("both tables carry every column in the snapshot — the writer simply never filled them.");

  log("");
  log("── BEFORE");
  const before = await survey("scope");

  /* Column names come from the two constant lists above, never from input, so
     the interpolated fragments are safe. LEFT JOIN, not JOIN: a DO whose SO is
     gone has to appear as an untouched document, not vanish from the count. */
  const nullAny = sql.unsafe(DO_COLS.map((c) => `d.${c} IS NULL`).join(" OR "));
  const rows = await sql`
    SELECT d.id::text AS id, d.do_number, d.so_doc_no, d.do_date::text AS do_date,
           ${sql.unsafe(DO_COLS.map((c) => `d.${c} AS "do_${c}"`).join(", "))},
           s.doc_no AS so_doc,
           ${sql.unsafe(SO_COLS.map((c) => `s.${c} AS "so_${c}"`).join(", "))}
      FROM scm.delivery_orders d
      LEFT JOIN scm.mfg_sales_orders s ON s.doc_no = d.so_doc_no
     WHERE d.company_id = ${CO} ${SCOPED} ${ONE}
       AND (${nullAny})
     ORDER BY d.do_number`;

  const noLink = rows.filter((r) => !r.so_doc_no);
  const dangling = rows.filter((r) => r.so_doc_no && !r.so_doc);
  const linked = rows.filter((r) => r.so_doc);

  log("");
  log("── PLAN");
  log(`   DOs with at least one snapshot column NULL        ${rows.length}`);
  log(`     no so_doc_no — NO PARENT, left alone            ${noLink.length}`);
  log(`     so_doc_no names an SO that is gone — left alone ${dangling.length}`);
  log(`     linked to a live SO                             ${linked.length}`);
  for (const r of noLink.slice(0, CAP)) log(`       LEFT ALONE ${r.do_number}: so_doc_no is NULL.`);
  for (const r of dangling.slice(0, CAP)) log(`       LEFT ALONE ${r.do_number}: so_doc_no ${r.so_doc_no} names no sales order.`);

  const perCol = Object.fromEntries(DO_COLS.map((c) => [c, 0]));
  const soBlank = Object.fromEntries(DO_COLS.map((c) => [c, 0]));
  const plan = [];
  for (const r of linked) {
    const so = Object.fromEntries(SO_COLS.map((c) => [c, r[`so_${c}`]]));
    const snap = soHeaderToDoSnapshot(so, { doDate: r.do_date });
    const sets = [];
    for (const col of DO_COLS) {
      if (r[`do_${col}`] != null) continue;
      const v = snap[col];
      if (v == null) { soBlank[col]++; continue; }
      perCol[col]++;
      sets.push([col, v]);
    }
    if (sets.length) plan.push({ r, sets });
  }
  log(`     of those, the SO actually has something to give ${plan.length}`);
  log("     per column: " + DO_COLS.filter((c) => perCol[c]).map((c) => `${c} ${perCol[c]}`).join(" · "));
  const blankCols = DO_COLS.filter((c) => soBlank[c]);
  if (blankCols.length) log("     SO itself blank (stays NULL, an SO-side gap): " + blankCols.map((c) => `${c} ${soBlank[c]}`).join(" · "));
  for (const p of plan.slice(0, CAP)) {
    log(`       ${p.r.do_number}  <- ${p.r.so_doc}`);
    for (const [c, v] of p.sets) log(`          ${c.padEnd(30)} NULL -> ${short(v)}`);
  }
  if (plan.length > CAP) log(`       ... ${plan.length - CAP} more (raise CAP)`);

  if (!APPLY) {
    log("");
    log("DRY-RUN — nothing was written. Set APPLY=1 to backfill.");
    await sql.end(); return;
  }

  /* One transaction. Each SET is guarded by its own IS NULL so a value written
     by anyone between the plan and the write survives untouched. */
  const written = await sql.begin(async (tx) => {
    let n = 0, skipped = 0;
    for (const p of plan) {
      const setSql = p.sets
        .map(([c], i) => `${c} = CASE WHEN ${c} IS NULL THEN $${i + 2} ELSE ${c} END`)
        .join(", ");
      const guard = p.sets.map(([c]) => `${c} IS NULL`).join(" OR ");
      const res = await tx.unsafe(
        `UPDATE scm.delivery_orders SET ${setSql} WHERE id = $1::uuid AND (${guard})`,
        [p.r.id, ...p.sets.map(([, v]) => v)],
      );
      if (res.count) n += res.count; else skipped++;
    }
    if (skipped) log(`   ${skipped} DO(s) matched nothing at write time — already filled by someone else.`);
    return n;
  });
  log("");
  log(`APPLIED: ${written} delivery_orders row(s) updated, in one transaction.`);

  log("");
  log("── INDEPENDENT READ-BACK (a fresh SELECT — a log line is not evidence)");
  const after = await survey("scope");
  log(`   address1 NULL               ${before.addr_null} -> ${after.addr_null}`);
  log(`   phone NULL                  ${before.phone_null} -> ${after.phone_null}`);
  log(`   email NULL                  ${before.email_null} -> ${after.email_null}`);
  log(`   salesperson_id NULL         ${before.sp_null} -> ${after.sp_null}`);
  log(`   customer_delivery_date NULL ${before.cdd_null} -> ${after.cdd_null}`);
  log("   Whatever is still NULL is NULL on the SO too — fix it there and re-run; this script is idempotent.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
