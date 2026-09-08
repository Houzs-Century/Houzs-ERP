#!/usr/bin/env node
/* Carry the sales / delivery fields onto the migrated delivery orders that
   never got them: salesperson, agent, branding, customer ref, the customer's
   delivery date and the expected-at date.
   ---------------------------------------------------------------------------
   THE GAP. Every migrated delivery order was written by
   lib/migrated-do-writer.mjs. docs/bugs/0714 carried the CUSTOMER BLOCK onto
   them (phone, email, address, city, state, postcode, emergency contact) and
   repaired production the same evening — 173 -> 0. The header block ABOVE that
   card on the same screen — Salesperson, Customer ref, Delivery date, Expected
   at — was blank for exactly the same cause and is not in that repair's field
   map (`DO_CARRY` is deliberately "what a driver needs, and nothing else").
   Owner, 2026-09-08, on HC-DO-011559: 「为什么DO没有显示客户信息」.

   THE SOURCE. A delivery order is a snapshot of its sales order at dispatch,
   and /from-sos (delivery-orders-mfg.ts) copies salesperson_id / agent /
   branding / ref / customer_delivery_date from the SO header and sets
   expected_delivery_at to the customer's date or, failing that, the creation
   date — which for a migrated document is its own do_date. That list is
   `DO_SALES_CARRY` in lib/customer-block.mjs, the SAME list the writer now
   applies to a new document, so the two cannot answer differently.

   NOT TOUCHED, on purpose: venue / venue_id (a canonicalising trigger rewrites
   them on write, so a repair must not move a value it did not measure —
   docs/bugs/0714's own reason); sales_location / warehouse_id (the ship-from
   branch from the account book, owner 2026-09-07 「记在单头就好」, never the
   order's sales branch — backfill-migrated-do-warehouse.mjs owns those).

   WHAT IT NEVER DOES. It never overwrites a stated value: every SET carries its
   own IS NULL, so a header a person corrected is invisible to it. Where the
   sales order is itself blank the field stays NULL and the plan names it — an
   SO-side gap, not something to invent. It writes no line, quantity, price,
   payment column or status, and no inventory movement.

   RE-RUN: idempotent and inert on a second run — every SET re-asserts IS NULL,
   so a second run plans 0 and writes 0.

   MODE=plan (default) prints the plan and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".
   SCOPE=migrated (default) = delivery_orders.migrated_no_stock = true;
   SCOPE=all = every delivery order in the company. DO_NUMBER limits to one. */
import postgres from "postgres";
import { DO_SALES_CARRY } from "./lib/customer-block.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const CO = Number(process.env.COMPANY_ID || 1);
const SCOPE = (process.env.SCOPE || "migrated").toLowerCase();
const ONLY_DO = (process.env.DO_NUMBER || "").trim() || null;
const CAP = Number(process.env.CAP || 40);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exit(2); };

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=plan first and read it.`);
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const MIGRATED_ONLY = SCOPE !== "all";
const COLS = DO_SALES_CARRY.map(([c]) => c);
const short = (v) => (v == null ? "-" : String(v).replace(/\s+/g, " ").slice(0, 50));

/* The scope predicate, as TEXT. Column names and expressions come from the
   constant list, never from input; the only parameters are the company, the
   optional document number and the id list. */
const scopeSql = (alias) =>
  `${alias}.company_id = $1${MIGRATED_ONLY ? ` AND ${alias}.migrated_no_stock = true` : ""}${ONLY_DO ? ` AND ${alias}.do_number = $2` : ""}`;
const scopeArgs = ONLY_DO ? [CO, ONLY_DO] : [CO];

async function survey(label) {
  const [r] = await sql.unsafe(
    `SELECT COUNT(*)::int AS docs,
            ${COLS.map((c) => `COUNT(*) FILTER (WHERE d.${c} IS NULL)::int AS "${c}"`).join(", ")}
       FROM scm.delivery_orders d
      WHERE ${scopeSql("d")}`, scopeArgs);
  note(`   ${label}: ${r.docs} delivery order(s) in scope — NULL per column: ` +
       COLS.map((c) => `${c} ${r[c]}`).join(" · "));
  return r;
}

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO} scope=${MIGRATED_ONLY ? "migrated documents only" : "ALL delivery orders"}${ONLY_DO ? ` do=${ONLY_DO}` : ""}`);

  const have = new Set((await sql`SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'delivery_orders'`).map((c) => c.column_name));
  const missing = COLS.filter((c) => !have.has(c));
  if (missing.length) { note(`REFUSING — scm.delivery_orders has no ${missing.join(", ")}.`); await sql.end(); return; }

  note("");
  note("── BEFORE");
  const before = await survey("scope");

  /* One row per document with at least one NULL, the sales order's answer
     beside each column. LEFT JOIN: a document whose order is gone must appear
     as an untouched row, not vanish from the count. */
  const rows = await sql.unsafe(
    `SELECT d.id::text AS id, d.do_number, d.so_doc_no, s.doc_no AS so_doc,
            ${DO_SALES_CARRY.map(([c, expr]) => `d.${c}::text AS "do_${c}", (${expr})::text AS "so_${c}"`).join(",\n            ")}
       FROM scm.delivery_orders d
       LEFT JOIN scm.mfg_sales_orders s ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
      WHERE ${scopeSql("d")}
        AND (${COLS.map((c) => `d.${c} IS NULL`).join(" OR ")})
      ORDER BY d.do_number`, scopeArgs);

  const noLink = rows.filter((r) => !r.so_doc_no);
  const dangling = rows.filter((r) => r.so_doc_no && !r.so_doc);
  const linked = rows.filter((r) => r.so_doc);

  const perCol = Object.fromEntries(COLS.map((c) => [c, 0]));
  const soBlank = Object.fromEntries(COLS.map((c) => [c, 0]));
  const plan = [];
  for (const r of linked) {
    const sets = [];
    for (const c of COLS) {
      if (r[`do_${c}`] != null) continue;
      if (r[`so_${c}`] == null) { soBlank[c]++; continue; }
      perCol[c]++;
      sets.push([c, r[`so_${c}`]]);
    }
    if (sets.length) plan.push({ r, sets });
  }

  note("");
  note("── PLAN");
  note(`   documents with at least one of the six NULL          ${rows.length}`);
  note(`     no so_doc_no — NO PARENT, left alone              ${noLink.length}`);
  note(`     so_doc_no names an order that is gone — left alone ${dangling.length}`);
  note(`     the order actually has something to give          ${plan.length}`);
  note("     per column: " + COLS.filter((c) => perCol[c]).map((c) => `${c} ${perCol[c]}`).join(" · "));
  const blank = COLS.filter((c) => soBlank[c]);
  if (blank.length) note("     order itself blank (stays NULL — an SO-side gap): " + blank.map((c) => `${c} ${soBlank[c]}`).join(" · "));
  for (const r of noLink.slice(0, CAP)) note(`       LEFT ALONE ${r.do_number}: so_doc_no is NULL.`);
  for (const r of dangling.slice(0, CAP)) note(`       LEFT ALONE ${r.do_number}: so_doc_no ${r.so_doc_no} names no sales order.`);
  for (const p of plan.slice(0, CAP)) {
    note(`       ${p.r.do_number}  <- ${p.r.so_doc}`);
    for (const [c, v] of p.sets) note(`          ${c.padEnd(24)} NULL -> ${short(v)}`);
  }
  if (plan.length > CAP) note(`       ... ${plan.length - CAP} more (raise CAP)`);

  if (!APPLY) {
    note("");
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end(); return;
  }

  /* ONE statement, ONE transaction. NO TABLE ALIAS on the UPDATE target — the
     release-discipline audit recognises a write by `UPDATE <name> SET`, and an
     aliased target would make this script read as if it wrote nothing. The
     expressions in DO_SALES_CARRY read the delivery order as `d`; rewritten to
     the full name here. IS NULL is re-asserted per column at write time, so a
     value written by anyone between the plan and this statement survives. */
  const ids = plan.map((p) => p.r.id);
  const T = "scm.delivery_orders";
  const asTarget = (expr) => expr.replace(/\bd\./g, `${T}.`);
  const written = await sql.begin(async (tx) => {
    const res = await tx.unsafe(
      `UPDATE scm.delivery_orders SET
         ${DO_SALES_CARRY.map(([c, expr]) => `${c} = CASE WHEN ${T}.${c} IS NULL THEN ${asTarget(expr)} ELSE ${T}.${c} END`).join(",\n         ")}
       FROM scm.mfg_sales_orders s
      WHERE ${T}.id = ANY($1::uuid[])
        AND s.doc_no = ${T}.so_doc_no AND s.company_id = ${T}.company_id
        AND (${COLS.map((c) => `${T}.${c} IS NULL`).join(" OR ")})`,
      [ids]);
    return res.count;
  });
  note("");
  note(`APPLIED: ${written} of ${ids.length} planned delivery order(s) updated, in one transaction.`);
  if (written !== ids.length) note(`   ${ids.length - written} matched nothing at write time — already filled by someone else.`);

  /* ── INDEPENDENT READ-BACK ────────────────────────────────────────────────
     A FRESH connection, and it asserts the SHAPE rather than a row count: every
     value the plan said it would write is read back, per document and per
     column, and compared with what the plan holds — which is what the sales
     order answers. Then the family invariant: still ZERO inventory movements
     on these documents. */
  note("");
  note("── READ-BACK (fresh connection)");
  const after = await survey("scope");
  for (const c of COLS) note(`   ${c.padEnd(24)} NULL ${before[c]} -> ${after[c]}`);
  const check = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  try {
    const back = ids.length
      ? await check.unsafe(
        `SELECT d.id::text AS id, ${COLS.map((c) => `d.${c}::text AS "${c}"`).join(", ")}
           FROM scm.delivery_orders d WHERE d.id = ANY($1::uuid[])`, [ids])
      : [];
    const byId = new Map(back.map((r) => [r.id, r]));
    let disagree = 0, stillNull = 0;
    for (const p of plan) {
      const row = byId.get(p.r.id);
      for (const [c, v] of p.sets) {
        const now = row?.[c] ?? null;
        if (now == null) { stillNull++; note(`   STILL NULL ${p.r.do_number}.${c}`); continue; }
        if (String(now) !== String(v)) { disagree++; note(`   DISAGREES ${p.r.do_number}.${c}: planned ${short(v)}, read back ${short(now)}`); }
      }
    }
    const [mv] = ids.length
      ? await check.unsafe(
        `SELECT COUNT(*)::int AS movements FROM scm.inventory_movements m
          WHERE m.source_doc_type = 'DO' AND m.source_doc_id = ANY($1::uuid[])`, [ids])
      : [{ movements: 0 }];
    note(`verify (fresh connection): ${plan.length} planned document(s) · values not as planned ${disagree}` +
         ` · still NULL ${stillNull} · inventory movements on these documents ${mv.movements}`);
    if (disagree || stillNull) bad("VERIFY FAILED: a written value is not the one the plan named. Investigate before trusting any header reading.");
    if (mv.movements > 0) bad(`VERIFY FAILED: ${mv.movements} inventory movement(s) exist on these migrated documents. They must have NONE.`);
    note("verify OK — every planned field reads back as its sales order's value, and no inventory moved.");
  } finally {
    await check.end({ timeout: 5 });
  }
  note("   Whatever is still NULL is NULL on the sales order too — fix it there and re-run; this script is idempotent.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
