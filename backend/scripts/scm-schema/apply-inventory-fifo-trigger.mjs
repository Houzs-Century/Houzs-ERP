// Apply the scm FIFO trigger + functions (inventory-fifo-trigger.sql) that the
// Drizzle export + views-only port left out, and ensure exactly one default
// warehouse exists so GRNs without an explicit warehouse still book inventory.
//
// ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION / (re)CREATE TRIGGER, plus a
// single UPDATE flagging a default warehouse. Touches no inventory data.
//
//   node scripts/scm-schema/apply-inventory-fifo-trigger.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const ddl = readFileSync("scripts/scm-schema/inventory-fifo-trigger.sql", "utf8");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL search_path TO scm, public");
    await tx.unsafe(ddl);

    // Ensure a single default warehouse. If none is flagged, promote the oldest
    // active one (deterministic) so defaultWarehouseId() resolves. No-op once set.
    const def = await tx`select id from scm.warehouses where is_default = true`;
    if (def.length === 0) {
      const picked = await tx`
        update scm.warehouses set is_default = true
         where id = (select id from scm.warehouses where is_active = true
                      order by created_at asc, code asc limit 1)
        returning code, id`;
      if (picked.length) console.log(`default warehouse set -> ${picked[0].code} (${picked[0].id})`);
      else console.log("WARNING: no active warehouse to flag as default");
    } else {
      console.log("default warehouse already set:", def.length, "row(s)");
    }
  });

  // ── Verify: trigger + functions now exist ──
  const trg = await sql`
    select count(*)::int c from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='scm' and c.relname='inventory_movements'
      and t.tgname='trg_inventory_movement_fifo' and not t.tgisinternal`;
  const fns = await sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='scm' and p.proname in
      ('fn_inventory_movement_fifo','fn_consume_fifo','fn_consume_fifo_batch')
    order by p.proname`;
  console.log("trigger present:", trg[0].c === 1);
  console.log("functions present:", fns.map(f=>f.proname).join(", "));

  // ── Self-test: IN movement now creates a lot (rolled back, no data kept) ──
  const wh = (await sql`select id from scm.warehouses where is_default=true limit 1`)[0]?.id;
  if (wh) {
    try {
      await sql.begin(async (tx) => {
        const ins = await tx`insert into scm.inventory_movements ${tx({
          movement_type:'IN', warehouse_id:wh, product_code:'ZZSELFTEST', variant_key:'',
          product_name:'selftest', qty:5, unit_cost_sen:1000,
          source_doc_type:'GRN', source_doc_no:'GRN-SELFTEST', performed_by:null,
        })} returning id`;
        const lots = await tx`select qty_received, unit_cost_sen from scm.inventory_lots where movement_id=${ins[0].id}`;
        const bal  = await tx`select qty from scm.inventory_balances where warehouse_id=${wh} and product_code='ZZSELFTEST'`;
        console.log(`SELFTEST: lot rows=${lots.length} qty=${lots[0]?.qty_received} cost=${lots[0]?.unit_cost_sen}; balance qty=${bal[0]?.qty}`);
        throw new Error("__ROLLBACK__");
      });
    } catch (e) { if (!String(e.message).includes("__ROLLBACK__")) throw e; }
  }
  console.log("DONE.");
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 500));
  process.exitCode = 2;
} finally {
  await sql.end();
}
