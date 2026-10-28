#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-sofa-price-rounding.mjs — does the sofa engine's whole-ringgit
// quantisation actually bite on live data?
//
// THE DEFECT IT SIZES. The sofa pricing engine works in whole MYR while the
// document works in sen, and the PERSISTED selling price crosses that boundary
// by ROUNDING:
//
//   shared/sofa-build.ts:503   price: Math.round(sen / 100)            per module
//   shared/sofa-build.ts:1260  Math.round(match.comboPriceSen / 100) per combo
//   shared/sofa-build.ts:533   Math.round(total * 100)                 back to sen
//
// and the result is WRITTEN to the line, not merely compared against it
// (lib/mfg-pricing-recompute.ts assigns it to `unitToPersistSen`).
//
// So four modules at RM1,299.50 persist as 4 x RM1,300 = RM5,200.00 when the
// parts sum to RM5,198.00 — RM2.00 overcharged, invisibly, on every build.
// Downward too: RM899.40 bills as RM899.00. The COST side stays in exact sen
// throughout, so margin is computed against a rounded revenue.
//
// WHY A SCRIPT AND NOT A FIX. The defect is certain in the code; its BLAST
// RADIUS is not. It only bites when a price feeding the engine is not a whole
// ringgit, and every writer of those columns is operator-entered — no computed
// or percentage source generates sub-ringgit sen. So the honest question is
// "do such rows exist in production", and that answer lives nowhere else.
// CLAUDE.md's rule is that the owner is not a database console: build the
// check, do not paste a SELECT into chat. Changing a pricing engine on a maybe
// is the wrong order of operations; this makes the maybe a number first.
//
// IT CHECKS THE THREE INPUTS THE ENGINE ACTUALLY READS, traced in source
// rather than guessed from column names — the names mislead here:
//
//   1. mfg_products.sell_price_sen          (sofa-build.ts:445 fallback)
//   2. seat_height_prices[].sellingPriceSen (sofa-build.ts:444 preferred)
//      NOT `.priceSen` in the same JSONB — that is COST (cost-anchor-sync.ts:42),
//      and cost never crosses the whole-MYR boundary.
//   3. the combo CHARGED price, which is neither column on its own:
//      comboChargedPrices() = {...prices_by_height} overlaid with the non-null
//      entries of selling_prices_by_height (sofa-combo-pricing.ts:92-101). A
//      height priced only on the cost column IS charged from it, so checking
//      selling alone would under-report.
//
// Combos are filtered exactly as loadActiveSofaCombos does — deleted_at,
// customer_id and supplier_id all NULL — so this counts the rows the sales
// path can actually price from, not the whole table.
//
// STRICTLY READ-ONLY. SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — including "none found", which is a real result
// and not a failure. Non-zero only when the database is unreachable.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });

const fmt = (sen) => `RM${(Number(sen) / 100).toFixed(2)}`;
/** What the engine would persist for this one price: Math.round(sen/100)*100. */
const persisted = (sen) => Math.round(Number(sen) / 100) * 100;

try {
  console.log("=== Sofa price rounding — does the whole-ringgit quantisation bite? ===\n");

  /* 1. Flat module price. `% 100 <> 0` is exactly the condition under which
        Math.round(sen / 100) moves money. */
  const modules = await sql`
    SELECT code, sell_price_sen
      FROM scm.mfg_products
     WHERE category = 'SOFA'
       AND sell_price_sen IS NOT NULL
       AND sell_price_sen % 100 <> 0
     ORDER BY sell_price_sen DESC
     LIMIT 200
  `;
  console.log(`1. SOFA module SKUs whose flat sell_price_sen is part-ringgit: ${modules.length}`);
  for (const m of modules.slice(0, 15)) {
    const d = persisted(m.sell_price_sen) - Number(m.sell_price_sen);
    console.log(`   ${String(m.code).padEnd(26)} ${fmt(m.sell_price_sen)} -> bills ${fmt(persisted(m.sell_price_sen))}  (${d > 0 ? "+" : ""}${fmt(d)}/unit)`);
  }
  if (!modules.length) console.log("   none.");

  /* 2. Per-(depth,tier) SELLING override — preferred over the flat price, so it
        is the value most builds actually use. `.priceSen` in the same array is
        COST and is deliberately not read. */
  const seats = await sql`
    SELECT code, seat_height_prices
      FROM scm.mfg_products
     WHERE category = 'SOFA'
       AND seat_height_prices IS NOT NULL
       AND jsonb_typeof(seat_height_prices::jsonb) = 'array'
  `;
  let seatOffenders = 0;
  for (const row of seats) {
    const arr = Array.isArray(row.seat_height_prices) ? row.seat_height_prices : [];
    for (const e of arr) {
      const v = Number(e?.sellingPriceSen ?? 0);
      if (v > 0 && v % 100 !== 0) {
        if (seatOffenders < 15) {
          const d = persisted(v) - v;
          console.log(`   ${String(row.code).padEnd(26)} h${e?.height ?? "?"}/${e?.tier ?? "-"} ${fmt(v)} -> bills ${fmt(persisted(v))}  (${d > 0 ? "+" : ""}${fmt(d)})`);
        }
        seatOffenders++;
      }
    }
  }
  console.log(`\n2. Seat-height SELLING overrides that are part-ringgit: ${seatOffenders}`);
  if (!seatOffenders) console.log("   none.");

  /* 3. Combo CHARGED price — the merge, not either column alone. */
  const combos = await sql`
    SELECT base_model, label, prices_by_height, selling_prices_by_height
      FROM scm.sofa_combo_pricing
     WHERE deleted_at IS NULL
       AND customer_id IS NULL
       AND supplier_id IS NULL
  `;
  let comboOffenders = 0;
  for (const row of combos) {
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    // comboChargedPrices: cost map, overlaid with the non-null selling entries.
    const charged = { ...obj(row.prices_by_height) };
    for (const [h, v] of Object.entries(obj(row.selling_prices_by_height))) {
      if (v !== null && v !== undefined) charged[h] = v;
    }
    for (const [h, v] of Object.entries(charged)) {
      const n = Number(v ?? 0);
      if (n > 0 && n % 100 !== 0) {
        if (comboOffenders < 15) {
          const d = persisted(n) - n;
          console.log(`   ${String(row.base_model).padEnd(20)} ${String(row.label ?? "").slice(0, 18).padEnd(18)} h${h} ${fmt(n)} -> bills ${fmt(persisted(n))}  (${d > 0 ? "+" : ""}${fmt(d)})`);
        }
        comboOffenders++;
      }
    }
  }
  console.log(`\n3. Combo CHARGED prices that are part-ringgit: ${comboOffenders} (of ${combos.length} sales-side combos)`);
  if (!comboOffenders) console.log("   none.");

  const total = modules.length + seatOffenders + comboOffenders;
  console.log("\n=== VERDICT ===");
  if (total === 0) {
    console.log("NOT REACHED on live data. Every sofa price the engine reads is a whole");
    console.log("ringgit today, so Math.round(sen / 100) is currently lossless. The defect");
    console.log("is still real in the code and bites the first time somebody prices a");
    console.log("module at RM1,299.50 — that argues for a GUARD (reject / warn on a");
    console.log("part-ringgit sofa price at the point of entry), not for rebuilding the");
    console.log("pricing engine to carry sen. No historical document is affected.");
  } else {
    console.log(`REACHED: ${total} price value(s) are part-ringgit, so any build using them`);
    console.log("persists a rounded selling price — over- or under-charging up to 50 sen");
    console.log("PER MODULE, and computing margin against a rounded revenue while cost");
    console.log("stays exact. The engine has to carry sen; a guard is not enough. Existing");
    console.log("documents priced from these rows need a separate impact pass.");
  }
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
