// Give a sofa module SKU the supplier its own model already has.
//
// WHY. On the MRP page a sofa line whose SKU has no supplier binding shows
// "— none —" in the Supplier column, so the buyer cannot even see who makes it
// (owner 2026-09-11, on `822-2A(LHF)`: 「822822 怎么会没有 Supplier 呢」).
// Measured on production the same day, company 1: of 739 sofa SKUs, **292 carry
// no supplier binding at all**, and that reaches **149 live sales-order lines
// across 79 orders**. It is not a code fault — nobody ever built those master
// rows. The pattern is one-sided twins: `822-1A(LHF)` is bound, `822-1A(RHF)`
// is not; `822-2A(RHF)` is bound, `822-2A(LHF)` is not.
//
// WHAT MAKES IT DERIVABLE. A sofa SKU is `<model>-<module>` — `822-CNR`,
// `822-2A(LHF)`, `9058-STOOL`. Every module of one model is built by the same
// maker, so an unbound module can take the supplier its bound SIBLINGS already
// name. That is copying a fact the master already holds, not inventing one.
//
// THE BAR, and why it refuses more than half the gap. A model qualifies ONLY
// when its bound siblings all name exactly ONE supplier. Measured 2026-09-11:
//   225  model has exactly one supplier            -> derivable
//    34  model has MORE THAN ONE supplier          -> refused, a person must pick
//    33  no sibling of that model is bound at all  -> refused, nothing to copy
// A two-supplier model cannot be guessed: picking the wrong maker sends a
// purchase order to a factory that does not build that piece.
//
// PRICE IS DELIBERATELY NOT COPIED — this is the one judgement in the file.
// A corner and a one-seater are the same model and NOT the same money, so the
// sibling's `unit_price_sen` is the one field that would be plausibly wrong
// rather than obviously wrong, and it feeds `deriveMfgPoUnitCost` straight into
// a purchase order's line total. New rows carry price 0, which is what "not
// priced yet" already means everywhere else — the same 0 these SKUs produce
// today with no binding at all, so it is not a regression. `lead_time_days` and
// `currency` ARE copied: they are properties of the SUPPLIER and the model, not
// of the module.
//
// MODE=plan (default) is READ-ONLY and prints every row it would write plus
// every one it refuses, with the reason. MODE=apply needs
// CONFIRM="DERIVE SOFA SUPPLIERS" and INSERTS only — it never updates or
// deletes an existing binding, so a row somebody has already set by hand is
// untouchable by this script.
//
// RE-RUN: idempotent. Every row it writes stops matching its own selector (the
// selector is "has NO binding"), so a second run reports 0 to write. It also
// re-asserts that emptiness inside the transaction, so a binding added by a
// person between the plan and the apply is left alone and logged.
//
// ENUM TRAP (house rule): status/category columns are enums — `::text` before
// comparing, never `COALESCE(col,'')`, which coerces '' INTO the enum and dies
// at plan time.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const MODE = (process.env.MODE ?? "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM ?? "";
const COMPANY = String(process.env.COMPANY ?? "1");
const CONFIRM_PHRASE = "DERIVE SOFA SUPPLIERS";

if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be plan or apply (got "${MODE}")`); process.exit(1);
}
if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); process.exit(1);
}

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

/* Every sofa SKU of this company that carries NO binding, with what its model's
   bound siblings say. `split_part(code,'-',1)` is the model — the same split the
   catalogue itself uses for a sofa code. */
const rows = await sql`
  with sku as (
    select p.code, p.name, split_part(p.code, '-', 1) as model
    from scm.mfg_products p
    where p.company_id::text = ${COMPANY} and p.category::text = 'SOFA'
  ),
  bound as (
    select s.model, b.supplier_id, b.currency::text as currency,
           max(b.lead_time_days) as lead_time_days
    from sku s
    join scm.supplier_material_bindings b
      on b.item_code = s.code and b.material_kind::text = 'mfg_product'
    group by s.model, b.supplier_id, b.currency::text
  ),
  model_supplier as (
    select model, count(*)::int supplier_count,
           min(supplier_id::text) as supplier_id,
           min(currency) as currency,
           max(lead_time_days) as lead_time_days
    from bound group by model
  )
  select s.code, s.name, s.model,
         m.supplier_count, m.supplier_id, m.currency, m.lead_time_days,
         sup.code as supplier_code, sup.name as supplier_name
  from sku s
  left join model_supplier m on m.model = s.model
  left join scm.suppliers sup on sup.id::text = m.supplier_id
  where not exists (
    select 1 from scm.supplier_material_bindings b
    where b.item_code = s.code and b.material_kind::text = 'mfg_product')
  order by s.model, s.code`;

const write = [];
const refuse = [];
for (const r of rows) {
  if (r.supplier_count == null) {
    refuse.push({ ...r, reason: `no sibling of model ${r.model} carries a supplier — nothing to copy` });
  } else if (Number(r.supplier_count) !== 1) {
    refuse.push({ ...r, reason: `model ${r.model} names ${r.supplier_count} different suppliers — a person must pick` });
  } else {
    write.push(r);
  }
}

console.log("\n=== WOULD WRITE — the model's single supplier, copied onto its unbound module ===");
console.log(`${pad("SKU", 22)}${pad("MODEL", 10)}${pad("SUPPLIER", 34)}LEAD`);
for (const r of write) {
  console.log(`${pad(r.code, 22)}${pad(r.model, 10)}${pad(`${r.supplier_code ?? "?"} · ${r.supplier_name ?? "?"}`, 34)}${r.lead_time_days ?? 0}d`);
}
console.log("\n=== REFUSED — left for a person, with the reason ===");
for (const r of refuse) console.log(`${pad(r.code, 22)}${r.reason}`);

notice(`plan: ${write.length} binding(s) to create, ${refuse.length} refused`);

if (MODE === "plan") {
  console.log(`\nPLAN ONLY — nothing was written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
  await sql.end();
  process.exit(0);
}

let wrote = 0;
await sql.begin(async (tx) => {
  for (const r of write) {
    /* Re-assert emptiness INSIDE the transaction: the plan may have been read
       minutes ago, and a binding somebody set by hand since must win. */
    const res = await tx`
      insert into scm.supplier_material_bindings
        (supplier_id, material_kind, item_code, material_name, supplier_sku,
         unit_price_sen, currency, lead_time_days, moq, is_main_supplier,
         is_cost_anchor, company_id, notes)
      select ${r.supplier_id}::uuid, 'mfg_product', ${r.code}, ${r.name ?? r.code}, '',
             0, ${r.currency ?? 'MYR'}::scm.currency_code, ${Number(r.lead_time_days ?? 0)}, 0, true,
             false, ${Number(COMPANY)},
             ${'derived 2026-09-11 from model ' + r.model + ' — price NOT copied, set it before pricing a PO'}
      where not exists (
        select 1 from scm.supplier_material_bindings b
        where b.item_code = ${r.code} and b.material_kind::text = 'mfg_product')
      returning id`;
    if (res.length === 1) wrote += 1;
    else console.log(`::warning::${r.code} was bound by someone else since the plan — left alone`);
  }
});
notice(`APPLIED: ${wrote} binding(s) created`);

/* ── Verification, on a FRESH connection ───────────────────────────────────
   A row count is not a shape. `insert ... returning id` reports one row for an
   insert that named the WRONG supplier, and the wrong maker is precisely the
   failure this script's refusal bar exists to prevent — so re-open a new
   connection and assert what each row now SAYS: the binding exists, names the
   supplier the model actually has, and carries price 0 as designed. */
await sql.end();
const verify = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const bad = [];
for (const r of write) {
  const got = await verify`
    select supplier_id::text sid, unit_price_sen, is_main_supplier, material_kind::text mk
    from scm.supplier_material_bindings
    where item_code = ${r.code} and material_kind::text = 'mfg_product'`;
  if (got.length !== 1) { bad.push(`${r.code}: expected exactly 1 binding, found ${got.length}`); continue; }
  const g = got[0];
  if (g.sid !== r.supplier_id) bad.push(`${r.code}: expected supplier ${r.supplier_id}, reads ${g.sid}`);
  else if (Number(g.unit_price_sen) !== 0) bad.push(`${r.code}: price should be 0 (not copied), reads ${g.unit_price_sen}`);
}
await verify.end();

if (bad.length > 0) {
  console.log("\n=== VERIFICATION FAILED — rows were written but do not read back correctly ===");
  for (const line of bad) console.log(`::error::${line}`);
  process.exit(1);
}
notice(`verified on a fresh connection: all ${write.length} binding(s) read back as planned`);
console.log("\nPRICE IS 0 ON EVERY NEW ROW BY DESIGN. Set the real price before these SKUs are priced onto a purchase order.");
