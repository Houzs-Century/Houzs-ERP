#!/usr/bin/env node
/* Read-only: how many live SO lines are showing the operator a stale stock
   status RIGHT NOW?

   WHY. Owner, 2026-08-16, on 2990-SO-2608-002: "why does it show READY in
   status when the item is pending and there is no incoming PO", and "my Stock
   Status ... now writes things like SHORT: MATTRESS". The label rule is fine;
   the INPUT is stale. `mfg_sales_order_items.stock_status` is written only by
   recomputeSoStockAllocation, ~34 of whose ~38 triggers are best-effort, and a
   sweep that lost the single-flight race returned `{ok:true}` and left no queue
   row for the cron to retry. So a line can sit at PENDING with the goods
   standing in the warehouse until some unrelated later mutation sweeps it.

   This counts that population before/after the fix, so the claim is a
   measurement and not an argument.

   ── WHAT IT MEASURES, AND WHAT IT DOES NOT ────────────────────────────────
   The allocator's own bucket key is `warehouse_id :: item_code ::
   computeVariantKey(item_group, variants)`. That key function is IMPORTED from
   src/scm/shared/variant-key.ts, not re-implemented — it is the one piece that
   could drift, so it is the one piece taken from the source of truth.

   The FIFO walk is NOT replayed (that needs the allocator itself, which takes
   the global lock — this probe must not block a production recompute). So the
   answer is reported as a BRACKET:

     UPPER  a non-READY line whose own bucket holds ANY on-hand stock. Some of
            these are legitimately PENDING because an older order already
            claimed the units — FIFO competition this probe cannot see.
     LOWER  the subset where the bucket's on-hand is >= the TOTAL outstanding
            demand of every non-READY line in that bucket. FIFO competition
            cannot explain these: there is enough for all of them and they are
            still PENDING. This is stale projection, or nothing.

   Demand is measured as `qty`, NOT qty-minus-delivered: a partly-shipped line
   therefore overstates its own demand, which can only make LOWER smaller. The
   conservative direction is deliberate — LOWER is a floor and must not be
   flattered.

   EXCLUDED, because the bucket lens does not describe them:
     · SOFA lines — allocated by whole-set dye-lot batch coverage, not buckets.
       Counted and reported separately, never folded into the bracket.
     · SERVICE lines — no inventory (isServiceLine, imported).
     · SOs with no processing date — `allocGated`: correctly PENDING by the
       owner's own rule ("有 processing date 才来分配"). Counted separately.
     · terminal SOs — SO_TERMINAL_STATES, imported.

   Read-only: SELECTs only. No DDL, no writes, no transaction, no lock. Exits 0
   for every legitimate answer; non-zero only if the database is unreachable. */
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import { isServiceLine } from "../src/scm/shared/service-sku.ts";
import { SO_TERMINAL_STATES } from "../src/scm/shared/so-terminal-states.ts";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const WH_NONE = "NOWH";

const bucketOf = (whId, itemCode, itemGroup, variants) =>
  `${whId ?? WH_NONE}::${itemCode}::${computeVariantKey(itemGroup, variants)}`;

async function main() {
  note("=== SO stock_status staleness probe (read-only) ===");
  note(`scope: ${CO == null ? "BOTH companies" : `company ${CO}`}`);
  note("");

  /* 1. Live, non-cancelled SO lines on non-terminal orders. `proceeded_at`
        rides along so the allocation gate can be reported rather than silently
        counted as staleness. */
  /* `status::text` — the document status columns are enums in this schema, so an
     uncast comparison against a text[] fails outright rather than answering
     wrongly; every audit script here casts. Same for the uuid[] below. */
  const coFilter = CO == null ? sql`` : sql`AND so.company_id = ${CO}`;
  const lines = await sql`
    SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.qty,
           i.warehouse_id, i.stock_status, so.proceeded_at, so.company_id
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.cancelled = false
       AND so.status::text <> ALL (${[...SO_TERMINAL_STATES]}::text[])
       ${coFilter}`;
  note(`live SO lines (non-cancelled, non-terminal SO): ${lines.length}`);

  /* 2. Live on-hand per bucket. inventory_balances already stores variant_key,
        so only the SO side needs computeVariantKey. */
  const balances = await sql`
    SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS variant_key,
           SUM(qty)::numeric AS qty
      FROM scm.inventory_balances
     GROUP BY warehouse_id, item_code, COALESCE(variant_key, '')`;
  const onHand = new Map();
  for (const b of balances) {
    const key = `${b.warehouse_id ?? WH_NONE}::${b.item_code}::${b.variant_key}`;
    onHand.set(key, (onHand.get(key) ?? 0) + Number(b.qty ?? 0));
  }
  note(`inventory buckets with a balance row: ${onHand.size}`);

  /* 3. Classify. The order of these tests matters — a line is attributed to the
        FIRST reason that explains it, so nothing is double-counted and nothing
        correctly-PENDING lands in the staleness bracket. */
  let ready = 0, service = 0, sofa = 0, gated = 0;
  const candidates = [];              // non-READY, non-sofa, non-service, proceeded
  for (const l of lines) {
    if (!l.item_code) continue;
    const group = (l.item_group ?? "").toUpperCase();
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: null })) { service += 1; continue; }
    if (group.includes("SOFA")) { sofa += 1; continue; }
    if ((l.stock_status ?? "").toUpperCase() === "READY") { ready += 1; continue; }
    if (!l.proceeded_at) { gated += 1; continue; }
    candidates.push({ ...l, bucket: bucketOf(l.warehouse_id, l.item_code, l.item_group, l.variants) });
  }
  note("");
  note("=== the live population, by why a line is not in the bracket ===");
  note(`  stored READY:                       ${ready}`);
  note(`  SERVICE lines (no inventory):        ${service}`);
  note(`  SOFA lines (batch-matched, not bucketed — see header): ${sofa}`);
  note(`  no processing date (allocGated — correctly PENDING):   ${gated}`);
  note(`  non-READY, proceeded, bucket-allocated:                ${candidates.length}   <- the bracket is drawn from these`);

  /* Total outstanding demand per bucket across every candidate, so LOWER can
     rule out FIFO competition rather than assume it away. */
  const demand = new Map();
  for (const c of candidates) demand.set(c.bucket, (demand.get(c.bucket) ?? 0) + Number(c.qty ?? 0));

  const upper = candidates.filter((c) => (onHand.get(c.bucket) ?? 0) > 0);
  const lower = upper.filter((c) => (onHand.get(c.bucket) ?? 0) >= (demand.get(c.bucket) ?? 0));

  note("");
  note("=== HOW MANY LINES ARE LYING TO THE OPERATOR RIGHT NOW ===");
  note(`  UPPER  non-READY with ANY on-hand in its own bucket:  ${upper.length}`);
  note(`  LOWER  ... and enough on-hand for ALL demand on that`);
  note(`         bucket, so FIFO competition cannot explain it: ${lower.length}`);
  note(`  the honest statement: between ${lower.length} and ${upper.length} live SO lines show`);
  note(`  PENDING/PARTIAL while the goods are in their own warehouse bucket.`);

  /* The owner's exact sentence was "the item is pending and there is no incoming
     PO". Split the floor on that, because a line with a PO on the way at least
     tells him something true. */
  const lowerIds = lower.map((c) => c.id);
  let noPo = 0;
  if (lowerIds.length > 0) {
    const [row] = await sql`
      SELECT count(*)::int AS n
        FROM scm.mfg_sales_order_items i
       WHERE i.id = ANY (${lowerIds}::uuid[])
         AND NOT EXISTS (
           SELECT 1 FROM scm.purchase_order_items poi
            WHERE poi.so_item_id = i.id)`;
    noPo = row?.n ?? 0;
  }
  note(`  of the ${lower.length} floor lines, ${noPo} have NO purchase-order line at all`);
  note("  (that is the owner's sentence verbatim: pending, and no incoming PO)");

  note("");
  note("=== the worst-affected orders (floor lines only, top 15) ===");
  const byDoc = new Map();
  for (const c of lower) byDoc.set(c.doc_no, (byDoc.get(c.doc_no) ?? 0) + 1);
  const worst = [...byDoc.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15);
  if (worst.length === 0) note("  none");
  for (const [doc, n] of worst) note(`  ${doc}: ${n} line(s)`);

  /* 4. The repair machinery's own state. A DEAD row means allocation has
        STOPPED and stays stopped until a human clears it — that is not a
        detail, it would invalidate every number above. */
  note("");
  note("=== the recompute queue + lock, right now ===");
  const q = await sql`
    SELECT job_key, state, attempts, deferrals, last_error, requested_at, next_attempt_at
      FROM scm.stock_allocation_recompute_queue`;
  if (q.length === 0) note("  queue: EMPTY (no repair pending — before this PR, also what a dropped request looks like)");
  for (const r of q) {
    note(`  queue ${r.job_key}: state=${r.state ?? "PENDING"} attempts=${r.attempts} deferrals=${r.deferrals ?? 0} requested_at=${r.requested_at?.toISOString?.() ?? r.requested_at}`);
    if (r.last_error) note(`    last_error: ${String(r.last_error).slice(0, 300)}`);
    if (String(r.state ?? "") === "DEAD") note("    ^^ DEAD LETTER: allocation has stopped system-wide and needs a human.");
  }
  const lk = await sql`SELECT lock_key, locked_by, locked_until FROM scm.stock_allocation_recompute_lock`;
  for (const r of lk) {
    const held = r.locked_by && r.locked_until && new Date(r.locked_until) > new Date();
    note(`  lock ${r.lock_key}: ${held ? `HELD until ${r.locked_until?.toISOString?.() ?? r.locked_until}` : "free"}`);
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    try { await sql.end(); } catch { /* connection already gone */ }
    /* Non-zero is reserved for "the database could not answer" — every
       legitimate count above exits 0, including zero stale lines. */
    process.exit(1);
  });
