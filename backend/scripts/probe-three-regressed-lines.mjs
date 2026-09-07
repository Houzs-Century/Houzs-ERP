#!/usr/bin/env node
// ---------------------------------------------------------------------------
// probe-three-regressed-lines.mjs — the detail the owner is owed about the THREE
// sales orders that went BACKWARDS in the 2026-09-08 allocation recompute.
//
// WHAT HAPPENED, so this file makes sense on its own. The recompute apply (run
// 34141612663, 2026-09-08 00:06-00:15 +08) advanced 112 orders and flipped 562
// lines to READY. Three went the other way — HC-SO-007676, HC-SO-011731,
// HC-SO-013348 — each on an ordinary MATTRESS line. He approved the apply on a
// dry run that said ZERO orders would regress; the AutoCount inventory re-seed
// (run 34140557010, 23:53 +08, 199 cells adjusted) landed BETWEEN the dry run
// and the apply and changed the answer. So the regression is not necessarily a
// defect, and the honest answer names which of the two it is, per order:
//
//   (a) the stock simply is not there any more — the re-seed wrote the cell
//       DOWN to AutoCount's balance, or
//   (b) the stock is there but an order with a stronger claim took it — the
//       allocator fills greedily by EFFECTIVE delivery date, then doc_no, then
//       created_at + line id (so-stock-allocation.ts step 5). Losing that race
//       is a legitimate competition outcome and not a bug.
//
// Sections 5 and 6 are what separate (a) from (b), and they are computed with
// the allocator's OWN priority order rather than a plausible-looking one.
//
// WHAT IT DELIBERATELY DOES NOT PRINT. Customer NAMES. This repository is
// PUBLIC and so are these logs; probe-effective-delivery-drift.yml states the
// same rule in its header. `debtor_code` is printed in full — it is the account
// code the owner looks the customer up by in AutoCount, and it identifies the
// row for him without publishing a person's name. The name is masked to its
// first two characters plus a length, which is enough to confirm you are
// looking at the right customer and not enough to be a customer list.
//
// READ-ONLY. Every statement is a SELECT: no DDL, no writes, no transaction.
// One statement per question, so a failure names the question it failed on.
//
// RE-RUN: inert. It reads and prints. Running it twice prints the same answer
// twice, unless the projection moved in between — which is the point of it.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { register } from "node:module";

// The variant key is the allocator's bucket identity. Compute it with the REAL
// function, never a re-implementation: a second copy of that rule is how stock
// silently lands in a different bucket in one place and not the other.
register("./_ts-resolve.mjs", import.meta.url);
const { computeVariantKey } = await import("../src/scm/shared/variant-key.ts");

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const DOCS = (process.env.DOCS || "HC-SO-007676,HC-SO-011731,HC-SO-013348")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CO = Number(process.env.COMPANY_ID || 1);
/* The window that contains BOTH the re-seed and the recompute apply, in UTC.
   2026-09-07 15:00Z = 2026-09-07 23:00 +08 — an hour before the re-seed started,
   so nothing in the sequence falls outside it. */
const SINCE = process.env.SINCE || "2026-09-07T15:00:00Z";

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* Local Malaysia time, because that is the only clock the owner reads. The ERP
   stores timestamptz, so this is a rendering choice and not an adjustment. */
const my = (t) => (t ? new Date(t).toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }) + " +08" : "-");
/* A name is masked, an account code is not. See the header. */
const mask = (n) => (n ? `${String(n).slice(0, 2)}${"*".repeat(Math.max(0, String(n).length - 2))} (${String(n).length} chars)` : "(blank)");

async function main() {
  log(`Company ${CO}; documents: ${DOCS.join(", ")}; window from ${my(SINCE)}.`);

  // ── 1. The three headers, as they stand right now ────────────────────────
  log("");
  log("=== 1. The three orders now ===");
  const heads = await sql`
    SELECT h.doc_no, h.debtor_code, h.debtor_name, h.status::text AS status,
           h.customer_delivery_date, h.amended_delivery_date, h.created_at, h.company_id
      FROM scm.mfg_sales_orders h
     WHERE h.doc_no = ANY(${DOCS})
     ORDER BY h.doc_no`;
  for (const h of heads) {
    log(`   ${h.doc_no}  status=${h.status}  customer=${h.debtor_code ?? "(no code)"} / ${mask(h.debtor_name)}`);
    log(`      delivery: promised ${h.customer_delivery_date ?? "-"}, amended ${h.amended_delivery_date ?? "-"}`
      + `  -> effective ${h.amended_delivery_date ?? h.customer_delivery_date ?? "(none)"}`);
  }
  if (heads.length !== DOCS.length) {
    log(`   NOTE: ${DOCS.length - heads.length} of the requested documents were not found in company ${CO}.`);
  }

  // ── 2. The header status transitions in the window ───────────────────────
  log("");
  log("=== 2. What the header did, and when (mfg_so_status_changes) ===");
  const changes = await sql`
    SELECT doc_no, from_status, to_status, notes, created_at
      FROM scm.mfg_so_status_changes
     WHERE doc_no = ANY(${DOCS}) AND created_at >= ${SINCE}
     ORDER BY doc_no, created_at`;
  if (changes.length === 0) log("   (no header status rows in the window)");
  for (const c of changes) {
    log(`   ${c.doc_no}  ${c.from_status ?? "?"} -> ${c.to_status}  at ${my(c.created_at)}  ${c.notes ?? ""}`);
  }

  // ── 3. Every line of the three orders ────────────────────────────────────
  log("");
  log("=== 3. The lines (the regressed one is the non-READY main line) ===");
  const lines = await sql`
    SELECT i.id, i.doc_no, i.item_code, i.item_group, i.qty, i.stock_qty_ready,
           i.stock_status, i.warehouse_id, i.variants, i.cancelled,
           w.name AS warehouse_name
      FROM scm.mfg_sales_order_items i
      LEFT JOIN scm.warehouses w ON w.id = i.warehouse_id
     WHERE i.doc_no = ANY(${DOCS})
     ORDER BY i.doc_no, i.item_code`;
  const buckets = new Map();
  for (const l of lines) {
    const vk = computeVariantKey(l.item_group ?? null, l.variants ?? null);
    l._vk = vk;
    l._bucket = `${l.warehouse_id ?? "NOWH"}::${l.item_code}::${vk}`;
    log(`   ${l.doc_no}  ${l.item_code}  group=${l.item_group ?? "-"}  qty=${l.qty}`
      + `  ready=${l.stock_qty_ready ?? 0}  status=${l.stock_status ?? "-"}`
      + `  warehouse=${l.warehouse_name ?? l.warehouse_id ?? "(none)"}`
      + `  variant_key='${vk}'${l.cancelled ? "  CANCELLED" : ""}`);
    if (!l.cancelled && l.stock_status !== "READY") buckets.set(l._bucket, l);
  }

  // ── 4. The line-level audit rows in the window ───────────────────────────
  log("");
  log("=== 4. What the allocator recorded about these orders in the window ===");
  const audits = await sql`
    SELECT so_doc_no, action, actor_name_snapshot, field_changes, note, created_at
      FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ANY(${DOCS}) AND created_at >= ${SINCE}
     ORDER BY so_doc_no, created_at`;
  if (audits.length === 0) log("   (no audit rows in the window)");
  for (const a of audits) {
    log(`   ${a.so_doc_no}  ${a.action}  by ${a.actor_name_snapshot ?? "-"}  at ${my(a.created_at)}`
      + `  ${JSON.stringify(a.field_changes ?? [])}${a.note ? ` note=${a.note}` : ""}`);
  }

  // ── 5. The stock under each regressed line: what is there, what moved ────
  log("");
  log("=== 5. The bucket under each regressed line ===");
  for (const [bucket, l] of buckets) {
    const [wh, code, vk] = [l.warehouse_id, l.item_code, l._vk];
    log("");
    log(`   ${l.doc_no} / ${code} @ ${l.warehouse_name ?? wh} (bucket ${bucket})`);

    const bal = await sql`
      SELECT COALESCE(SUM(qty), 0)::numeric AS qty
        FROM scm.inventory_balances
       WHERE warehouse_id = ${wh} AND item_code = ${code}
         AND COALESCE(variant_key, '') = ${vk}`;
    log(`      on hand NOW in this bucket: ${bal[0].qty}`);

    /* Every movement in the window, so "which stock moved underneath it" has an
       answer with a document on it rather than a shrug. AC_CUTOVER is the
       re-seed's own source_doc_type. */
    const movs = await sql`
      SELECT movement_type, qty, source_doc_type, source_doc_no, created_at
        FROM scm.inventory_movements
       WHERE warehouse_id = ${wh} AND item_code = ${code}
         AND COALESCE(variant_key, '') = ${vk}
         AND created_at >= ${SINCE}
       ORDER BY created_at`;
    if (movs.length === 0) log("      movements in the window: NONE — the stock in this bucket did not move");
    for (const m of movs) {
      log(`      ${my(m.created_at)}  ${m.movement_type} ${m.qty}  ${m.source_doc_type ?? "-"} ${m.source_doc_no ?? ""}`);
    }

    /* And the same bucket ACROSS every variant key, because a re-seed writes to
       the blank-variant cell AutoCount's snapshot carries. A line can lose its
       supply to a variant mismatch rather than to a quantity change, and the two
       read identically if you only ask about one key. */
    const byKey = await sql`
      SELECT COALESCE(variant_key, '') AS variant_key, SUM(qty)::numeric AS qty
        FROM scm.inventory_balances
       WHERE warehouse_id = ${wh} AND item_code = ${code}
       GROUP BY 1 ORDER BY 1`;
    log(`      the same item at this warehouse, by variant key: `
      + (byKey.map((r) => `'${r.variant_key}'=${r.qty}`).join(", ") || "(no rows)"));
  }

  // ── 6. Who else wants this bucket, in the allocator's own priority order ──
  log("");
  log("=== 6. The queue for each bucket — the allocator's own order ===");
  log("   Priority: effective delivery date, then doc_no, then created_at + line id.");
  log("   (so-stock-allocation.ts step 5. Effective date = amended, else promised.)");
  for (const [bucket, target] of buckets) {
    log("");
    log(`   ${bucket}`);
    /* Every OPEN line drawing on the same warehouse + item. The variant key is
       computed in JS below with the real function, because it is not a column.
       Terminal orders and cancelled lines are excluded exactly as the allocator
       excludes them. */
    const rivals = await sql`
      SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.qty,
             i.stock_qty_ready, i.stock_status,
             h.customer_delivery_date, h.amended_delivery_date, h.created_at, h.status::text AS so_status
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO}
         AND COALESCE(i.cancelled, false) = false
         AND i.warehouse_id = ${target.warehouse_id}
         AND i.item_code = ${target.item_code}
         AND h.status::text NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
       ORDER BY i.doc_no`;
    const FAR = "9999-12-31";
    const ranked = rivals
      .filter((r) => computeVariantKey(r.item_group ?? null, r.variants ?? null) === target._vk)
      .map((r) => ({
        ...r,
        eff: (r.amended_delivery_date ?? r.customer_delivery_date ?? FAR),
      }))
      .sort((a, b) => String(a.eff).localeCompare(String(b.eff))
        || a.doc_no.localeCompare(b.doc_no)
        || String(a.created_at).localeCompare(String(b.created_at))
        || a.id.localeCompare(b.id));

    const onHand = Number((await sql`
      SELECT COALESCE(SUM(qty), 0)::numeric AS qty
        FROM scm.inventory_balances
       WHERE warehouse_id = ${target.warehouse_id} AND item_code = ${target.item_code}
         AND COALESCE(variant_key, '') = ${target._vk}`)[0].qty);

    let running = 0;
    for (const r of ranked) {
      const before = running;
      running += Number(r.qty ?? 0);
      const mark = r.id === target.id ? "  <== THIS LINE" : "";
      log(`      ${r.eff}  ${r.doc_no}  qty=${r.qty}  status=${r.stock_status ?? "-"}`
        + `  demand ahead of it=${before}  cumulative=${running}${mark}`);
    }
    const ahead = ranked.slice(0, ranked.findIndex((r) => r.id === target.id))
      .reduce((s, r) => s + Number(r.qty ?? 0), 0);
    log(`      on hand ${onHand}; demand ranked AHEAD of this line ${ahead}; this line wants ${target.qty}.`);
    log(`      VERDICT: ${
      onHand === 0 && ahead === 0
        ? "the bucket is EMPTY — nobody took it, the stock is simply not there"
        : ahead >= onHand
          ? `OUT-COMPETED — ${ahead} unit(s) of higher-priority demand stand in front of ${onHand} on hand`
          : ahead + Number(target.qty ?? 0) > onHand
            ? `PARTIAL — ${onHand - ahead} unit(s) left for a line that wants ${target.qty}`
            : "NOT EXPLAINED by this bucket — on hand covers everything ahead of it plus this line; look at section 5"
    }`);
  }

  log("");
  log("Read-only probe finished.");
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("PROBE_FAILED", e?.message ?? e);
    try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
    process.exit(2);
  });
