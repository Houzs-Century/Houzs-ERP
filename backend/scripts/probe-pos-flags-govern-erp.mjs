#!/usr/bin/env node
/* Read-only: how much of the ERP's own catalogue is governed by POS flags.

   THE QUESTION. Two rules in the ERP are decided by a column the POS owns
   (`scm.mfg_products.pos_active`) or by a price the POS master authors
   (`scm.mfg_products.sell_price_sen`). Neither was chosen here. Before either
   is changed, this counts how many products and lines they actually reach.

   RULE 1 — pos_active refuses an ERP action.
     backend/src/scm/routes/mfg-sales-orders.ts, tbcSwapCommandHandler:
       if (prod.status !== 'ACTIVE' || !prod.pos_active) -> 409 product_inactive
     That is the ONLY SO write path in the file that reads pos_active; every
     other one gates on status === 'ACTIVE' alone. So a product the ERP sells
     can be added to an order and cannot be swapped TO. The same flag also
     filters the HR commission item-KPI picker (routes/hr.ts, the mfg_products
     leg of the picker fan-out), so such a product can carry no commission KPI.
     `active_not_pos` below is the population both rules hit.

   RULE 2 — the selling price auto-fills from the POS master, and a 0 does not
   stand. The UI seeds `unitPriceSen: p.sell_price_sen ?? 0` on pick, and the
   server (lib/mfg-pricing-recompute.ts) treats a submitted 0 as "not provided"
   and writes the catalogue figure over it. `active_pos_unpriced` is the set
   where that seed is RM 0 to begin with — the case the SoLineCard comment says
   booked RM 0 lines.

   WHAT THIS CANNOT ANSWER, said plainly: the database holds the price AFTER
   the server's refill, so no query here can separate "the operator typed the
   catalogue price" from "the operator sent 0 and the server replaced it". The
   `zero_priced_live_lines` count is NOT that measurement — it is the opposite,
   the lines where a 0 survived because the product had no catalogue price to
   refill from. Settling the refill needs a code decision, not this probe.

   Writes nothing. One connection, plain SELECTs, no DDL, no transaction.

   RE-RUN: identical. Nothing is written, so a second run reports the same
   numbers against the same data.
*/
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = Number(process.env.COMPANY || 1);

async function main() {
  note(`company_id = ${CO}`);

  /* Rule 1 + the RM 0 seed, in one pass over the catalogue. */
  const [cat] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
      count(*) FILTER (WHERE status = 'ACTIVE' AND pos_active IS NOT TRUE)::int AS active_not_pos,
      count(*) FILTER (WHERE status = 'ACTIVE' AND pos_active IS TRUE
                         AND COALESCE(sell_price_sen, 0) = 0)::int AS active_pos_unpriced
    FROM scm.mfg_products
    WHERE company_id = ${CO}`;

  note(`products: ${cat.total} total, ${cat.active} ACTIVE`);
  note(`ACTIVE but pos_active is not true: ${cat.active_not_pos}  ` +
       `-> refused by the TBC product swap, and invisible to the HR item-KPI picker`);
  note(`ACTIVE + pos_active with no sell_price_sen: ${cat.active_pos_unpriced}  ` +
       `-> the line-price auto-fill seeds RM 0 for these`);

  /* A worked sample, so the counts are checkable against real codes rather
     than believed. Read-only, capped. */
  const sample = await sql`
    SELECT code, name, category
    FROM scm.mfg_products
    WHERE company_id = ${CO} AND status = 'ACTIVE' AND pos_active IS NOT TRUE
    ORDER BY code
    LIMIT 15`;
  if (sample.length === 0) {
    note(`no ACTIVE-but-not-pos_active product exists in company ${CO} — rule 1 reaches nothing here`);
  } else {
    note(`sample of ACTIVE-but-not-pos_active (max 15):`);
    for (const r of sample) note(`  ${r.code}  [${r.category ?? '-'}]  ${r.name ?? ''}`);
  }

  /* Live SO lines sitting at 0. See the header: this bounds where a 0 STOOD,
     it does not measure where a 0 was overwritten. */
  const [lines] = await sql`
    SELECT
      count(*)::int AS live_lines,
      count(*) FILTER (WHERE COALESCE(i.unit_price_sen, 0) = 0)::int AS zero_priced_live_lines
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
    WHERE o.company_id = ${CO}
      AND COALESCE(i.cancelled, false) = false`;
  note(`live SO lines: ${lines.live_lines}, of which priced at 0: ${lines.zero_priced_live_lines}`);
}

main()
  .then(() => sql.end())
  /* Exit 0 for every legitimate answer; non-zero only when the DB is
     unreachable. A red job would read as "the check broke". */
  .catch(async (e) => { console.error(String(e?.message ?? e)); await sql.end(); process.exit(1); });
