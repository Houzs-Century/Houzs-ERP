#!/usr/bin/env node
// Read-only SKU cost-provenance trace for one Sales Order.
//
// WHY (owner, 2026-08-08): 2990-SO-2608-008 line "2990 KETTA-FIRM MATT (K)"
// shows unit COST RM2,567.60 against unit sell RM2,990.00 (86%) — "costing
// 怎么可能那么高?哪里搞错了?" — while 2990-SO-2607-019 (sofa, CONFIRMED,
// undelivered) shows NO cost at all (every line 0, margin 100%). Both figures
// are the SAME column read the SAME way; this script prints every number that
// could have fed it so the wrong one is identifiable by inspection.
//
// WHAT THE CODE SAYS THAT COLUMN IS (trace of origin/main, 2026-08-08):
//   mfg_sales_order_items.unit_cost_sen is the ①-stage ORDER-TIME ESTIMATE
//   (fulfillment-costing.ts three-way model: ① SO estimate, ② DO ship-time
//   FIFO, ③ SI landed after PI recost). It is stamped at SO create
//   (mfg-sales-orders.ts ~4155: recompute unit_cost_sen > 0, else
//   snapshotUnitCostSen ~1120 = mfg_products.cost_price_sen) and on line edit
//   (~8067 precedence: explicit client cost > recompute > re-snapshot on code
//   change > keep prior). The recompute's cost for MATTRESS/ACCESSORY is
//   mfg_products.base_price_sen ?? cost_price_sen (shared/mfg-pricing.ts
//   computeMfgLineCost ~483); for SOFA it is the per-(height,tier) COST grid
//   seat_height_prices[].priceSen summed per module (mfg-pricing-recompute.ts
//   ~463). NOTHING ever writes a FIFO/GRN/PI cost back onto the SO line — the
//   actuals land on delivery_order_items (restampDoActualCost / ship_cost_sen)
//   and sales_invoice_items (recost.ts) only. So:
//     * a WRONG NON-ZERO SO cost = a wrong PRODUCT-MASTER cost field, and
//     * an ALL-ZERO SO cost = the product master carries no cost for those
//       SKUs (designed degrade: real cost appears on the DO at ship / SI at PI).
//   One known feeder of the product-master field: the cost-anchor supplier
//   binding mirror (suppliers.ts syncAnchoredProductFromBinding →
//   cost-anchor-sync.ts FLAT lane) copies supplier_material_bindings
//   .unit_price_sen → mfg_products.base_price_sen 1:1 WITH NO CURRENCY
//   CONVERSION, and the binding HAS a currency column (can be RMB). This
//   script prints the binding currency so that case is visible.
//
// WHAT IT PRINTS, for SO_DOC_NO (default 2990-SO-2608-008), lines matching the
// free-text SKU (default KETTA; empty = every goods line):
//   [1] SO header + company + stored cost/margin totals
//   [2] every line's stamped qty/sell/cost/margin (the exact figures the SO
//       Detail Listing shows a finance viewer)
//   [3] per traced item_code:
//       a. mfg_products rows for the code in EVERY company (code is not
//          unique across companies) — cost_price_sen / base_price_sen /
//          price1_sen / sell_price_sen / seat-cost-grid summary, and WHICH
//          field (if any) equals the stamped SO cost
//       b. supplier_material_bindings for the code — unit_price_sen,
//          CURRENCY, is_cost_anchor, price_matrix presence
//       c. master_price_history — who/when last changed the cost fields
//       d. FIFO lots (qty received/remaining, unit_cost_sen, batch/source GRN)
//       e. each source GRN's currency + exchange_rate + line price, and the
//          PI lines billing it (qty, price, currency, rate, → MYR landed unit)
//       f. downstream DO/SI lines for the SO's lines (actual ②/③ costs)
//   [4] a per-line verdict naming the source that fed the stamped figure.
//
// STRICTLY READ-ONLY. SELECT only — no writes, no DDL, no transaction. Every
// interpolated identifier is discovered from information_schema and validated
// against ^[a-z_][a-z0-9_]*$; all VALUES go through parameter binding. Exits 0
// for every legitimate answer (the ANSWER is the output); non-zero only when
// the database is unreachable or a query errors. Mirrors
// check-costless-stock.mjs / check-so-source-trace.mjs (the repo's read-only
// diagnostic shape); workflow: .github/workflows/sku-cost-trace-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const SO_DOC_NO = (process.env.SO_DOC_NO ?? "2990-SO-2608-008").trim();
const SKU = (process.env.SKU ?? "KETTA").trim();

const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m) => console.log(m);

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const rm = (sen) =>
  sen == null ? "—" : `RM${(Number(sen) / 100).toFixed(2)}`;
const short = (s, n) => {
  const v = s == null ? "—" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

async function schemaOf(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table}
       AND table_schema IN ('scm','public')
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r[0]?.table_schema ?? null;
}
async function colsOf(schema, table) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}
// Table handle: resolves schema + columns once; .sel(list) keeps only the
// columns that exist so an env without a later migration still answers.
async function handle(table) {
  const schema = await schemaOf(table);
  if (!schema) return null;
  const cols = await colsOf(schema, table);
  return {
    q: `"${ident(schema)}"."${ident(table)}"`,
    cols,
    has: (c) => cols.has(c),
    sel: (list) => list.filter((c) => cols.has(c)).map(ident).join(", "),
  };
}

async function main() {
  notice("=== SKU COST TRACE — READ-ONLY (SELECTs only; no rows changed) ===");
  notice(`inputs: SO_DOC_NO=${SO_DOC_NO}  SKU="${SKU}" (free text; empty = all goods lines)`);
  line("");

  const so = await handle("mfg_sales_orders");
  const soi = await handle("mfg_sales_order_items");
  if (!so || !soi) {
    notice("FATAL — mfg_sales_orders / mfg_sales_order_items not found in scm or public. (Schema condition, not a data answer.)");
    return;
  }

  // ── [1] SO header ─────────────────────────────────────────────────────────
  const hdrCols = so.sel([
    "doc_no", "company_id", "status", "so_date", "created_at", "debtor_name",
    "local_total_sen", "total_cost_sen", "total_margin_sen",
    "margin_pct_basis", "mattress_sofa_cost_sen", "line_count",
  ]);
  const hdr = (await pg.unsafe(
    `SELECT ${hdrCols} FROM ${so.q} WHERE doc_no = $1`, [SO_DOC_NO],
  ))[0];
  if (!hdr) {
    notice(`VERDICT — Sales Order ${SO_DOC_NO} does not exist in this database. Nothing to trace. (Legitimate answer.)`);
    return;
  }
  const companyId = hdr.company_id ?? null;
  line(`[1] SO ${hdr.doc_no}  company_id=${companyId ?? "—"}  status=${hdr.status}  so_date=${hdr.so_date ?? "—"}  created_at=${hdr.created_at ?? "—"}`);
  line(`    debtor=${short(hdr.debtor_name, 40)}  total=${rm(hdr.local_total_sen)}  TOTAL COST=${rm(hdr.total_cost_sen)}  margin=${rm(hdr.total_margin_sen)}  margin_bp=${hdr.margin_pct_basis ?? "—"}`);
  line("");

  // ── [2] every line's stamped figures ──────────────────────────────────────
  const liCols = soi.sel([
    "id", "item_code", "description", "item_group", "qty", "cancelled",
    "unit_price_sen", "discount_sen", "total_sen",
    "unit_cost_sen", "line_cost_sen", "line_margin_sen", "warehouse_id",
  ]);
  const items = await pg.unsafe(
    `SELECT ${liCols} FROM ${soi.q} WHERE doc_no = $1 ORDER BY id`, [SO_DOC_NO],
  );
  line(`[2] SO lines (${items.length}) — stamped order-time figures (col: mfg_sales_order_items.unit_cost_sen):`);
  for (const it of items) {
    line(
      `    ${short(it.item_code, 34).padEnd(34)} ${short(it.description, 30).padEnd(30)} qty=${String(it.qty).padStart(3)}  sell=${rm(it.unit_price_sen).padStart(11)}  COST=${rm(it.unit_cost_sen).padStart(11)}  lineCost=${rm(it.line_cost_sen).padStart(12)}  margin=${rm(it.line_margin_sen).padStart(12)}${it.cancelled ? "  [CANCELLED]" : ""}`,
    );
  }
  line("");

  // ── resolve the traced lines from the free-text SKU ───────────────────────
  const skuUp = SKU.toUpperCase();
  const isService = (code) => String(code ?? "").toUpperCase().startsWith("SVC-");
  let traced = items.filter(
    (it) =>
      !it.cancelled &&
      !isService(it.item_code) &&
      (skuUp === "" ||
        String(it.item_code ?? "").toUpperCase().includes(skuUp) ||
        String(it.description ?? "").toUpperCase().includes(skuUp)),
  );
  if (traced.length === 0) {
    line(`    No line matches "${SKU}" — tracing ALL non-cancelled goods lines instead.`);
    traced = items.filter((it) => !it.cancelled && !isService(it.item_code));
  }
  const codes = [...new Set(traced.map((it) => String(it.item_code)))];
  line(`    Traced item_code(s): ${codes.join(", ") || "(none)"}`);
  line("");
  if (codes.length === 0) {
    notice("VERDICT — the SO has no goods lines to trace. (Legitimate answer.)");
    return;
  }

  // ── table handles for the provenance walk ─────────────────────────────────
  const prod = await handle("mfg_products");
  const smb = await handle("supplier_material_bindings");
  const sup = await handle("suppliers");
  const mph = await handle("master_price_history");
  const lots = await handle("inventory_lots");
  const grns = await handle("grns");
  const grnItems = await handle("grn_items");
  const pi = await handle("purchase_invoices");
  const piItems = await handle("purchase_invoice_items");
  const doi = await handle("delivery_order_items");
  const dos = await handle("delivery_orders");
  const sii = await handle("sales_invoice_items");
  const sis = await handle("sales_invoices");

  const verdicts = [];

  for (const code of codes) {
    const myLines = traced.filter((it) => String(it.item_code) === code);
    const stamped = [...new Set(myLines.map((it) => Number(it.unit_cost_sen ?? 0)))];
    line(`──────────────────────────────────────────────────────────────────────`);
    line(`[3] ${code} — stamped unit cost(s): ${stamped.map(rm).join(", ")}`);

    // a. product master rows — EVERY company (code is a partial key).
    let prodRows = [];
    if (prod) {
      const pCols = prod.sel([
        "id", "company_id", "category", "base_model", "status",
        "cost_price_sen", "base_price_sen", "price1_sen", "sell_price_sen",
        "seat_height_prices", "updated_at",
      ]);
      const pOrder = prod.has("company_id") ? " ORDER BY company_id NULLS LAST" : "";
      prodRows = await pg.unsafe(
        `SELECT ${pCols} FROM ${prod.q} WHERE code = $1${pOrder}`, [code],
      );
      line(`  (a) mfg_products rows for this code: ${prodRows.length}`);
      for (const p of prodRows) {
        const seat = Array.isArray(p.seat_height_prices) ? p.seat_height_prices : [];
        const seatCosted = seat.filter((r) => r && r.priceSen != null && Number(r.priceSen) > 0);
        const mine = companyId != null && p.company_id != null && Number(p.company_id) === Number(companyId);
        line(
          `      company=${p.company_id ?? "—"}${mine ? " <== SO company (the costing read)" : ""}  cat=${p.category}  status=${p.status ?? "—"}  cost_price_sen=${rm(p.cost_price_sen)}  base_price_sen=${rm(p.base_price_sen)}  price1_sen=${rm(p.price1_sen)}  sell_price_sen=${rm(p.sell_price_sen)}  seat-cost-rows=${seatCosted.length}/${seat.length}  updated=${short(p.updated_at, 20)}`,
        );
        if (mine) {
          for (const s of stamped) {
            if (s <= 0) continue;
            const matches = [];
            if (Number(p.base_price_sen ?? -1) === s) matches.push("base_price_sen");
            if (Number(p.cost_price_sen ?? -1) === s) matches.push("cost_price_sen");
            if (Number(p.price1_sen ?? -1) === s) matches.push("price1_sen");
            for (const r of seatCosted) if (Number(r.priceSen) === s) matches.push(`seat_height_prices[${r.height}/${r.tier ?? "P2"}].priceSen`);
            if (matches.length > 0) {
              verdicts.push(`${code}: stamped ${rm(s)} EQUALS mfg_products.${matches.join(" & ")} (company ${p.company_id}) — the SO figure is the PRODUCT-MASTER order-time estimate, not a FIFO/GRN/PI cost.`);
            }
          }
        }
      }
      const mineRow = prodRows.find((p) => companyId == null || p.company_id == null || Number(p.company_id) === Number(companyId));
      for (const s of stamped) {
        if (s === 0) {
          const flat = mineRow ? Number(mineRow.base_price_sen ?? 0) || Number(mineRow.cost_price_sen ?? 0) : 0;
          if (!mineRow) {
            verdicts.push(`${code}: stamped RM0.00 and NO product row exists for the SO's company — both cost sources (recompute + snapshot) had nothing to read. Designed degrade: real cost lands on the DO at ship (FIFO) / SI after PI.`);
          } else if (flat === 0) {
            const seat = Array.isArray(mineRow.seat_height_prices) ? mineRow.seat_height_prices : [];
            const seatCosted = seat.filter((r) => r && r.priceSen != null && Number(r.priceSen) > 0);
            verdicts.push(`${code}: stamped RM0.00 because the company-${mineRow.company_id ?? "?"} product row carries NO cost (cost_price_sen=${rm(mineRow.cost_price_sen)}, base_price_sen=${rm(mineRow.base_price_sen)}, costed seat rows=${seatCosted.length}). The SO estimate stays 0 until the master cost is filled; the ②/③ actuals appear on DO/SI, never back on the SO.`);
          }
        }
      }
    } else {
      line("  (a) mfg_products table not found — skipped.");
    }

    // b. supplier bindings — the cost-anchor mirror feeds base_price_sen 1:1
    //    with NO currency conversion (cost-anchor-sync FLAT lane).
    if (smb) {
      const bCols = smb.sel([
        "id", "supplier_id", "unit_price_sen", "currency", "is_cost_anchor",
        "price_matrix", "updated_at", "company_id",
      ]);
      const bind = await pg.unsafe(
        `SELECT ${bCols} FROM ${smb.q} WHERE material_code = $1 ORDER BY updated_at DESC LIMIT 10`, [code],
      );
      line(`  (b) supplier_material_bindings for this code: ${bind.length}`);
      for (const b of bind) {
        let supName = "—";
        if (sup && b.supplier_id) {
          const s = await pg.unsafe(
            `SELECT ${sup.sel(["name", "country"])} FROM ${sup.q} WHERE id = $1`, [b.supplier_id],
          );
          supName = s[0] ? `${s[0].name}${s[0].country ? ` (${s[0].country})` : ""}` : "—";
        }
        const anchor = smb.has("is_cost_anchor") ? (b.is_cost_anchor ? "YES" : "no") : "n/a";
        line(`      supplier=${short(supName, 34)}  unit_price=${rm(b.unit_price_sen)}  currency=${b.currency ?? "MYR"}  cost_anchor=${anchor}  matrix=${b.price_matrix ? "yes" : "no"}  updated=${short(b.updated_at, 20)}`);
        const cur = String(b.currency ?? "MYR").toUpperCase();
        for (const s of stamped) {
          if (s > 0 && Number(b.unit_price_sen ?? -1) === s && cur !== "MYR") {
            verdicts.push(`${code}: WARNING — the supplier binding price ${cur} ${(s / 100).toFixed(2)} equals the stamped SO cost figure, and the cost-anchor mirror (suppliers.ts syncAnchoredProductFromBinding -> cost-anchor-sync FLAT lane) copies binding.unit_price_sen into mfg_products.base_price_sen 1:1 with NO currency conversion. The "RM" cost is very likely a raw ${cur} figure.`);
          }
        }
      }
    }

    // c. who/when last changed the master cost fields.
    if (mph) {
      const hCols = mph.sel(["field", "old_value_sen", "new_value_sen", "reason", "changed_at", "changed_by"]);
      const hist = await pg.unsafe(
        `SELECT ${hCols} FROM ${mph.q} WHERE product_code = $1 ORDER BY changed_at DESC LIMIT 10`, [code],
      );
      line(`  (c) master_price_history (latest ${hist.length}):`);
      for (const h of hist) {
        line(`      ${short(h.changed_at, 20)}  ${String(h.field).padEnd(16)} ${rm(h.old_value_sen).padStart(11)} -> ${rm(h.new_value_sen).padStart(11)}  ${short(h.reason, 40)}`);
      }
    }

    // d. FIFO lots for the SKU (SO company when the column exists).
    let lotRows = [];
    if (lots) {
      const lCols = lots.sel([
        "id", "warehouse_id", "qty_received", "qty_remaining", "unit_cost_sen",
        "batch_no", "source_doc_type", "source_doc_id", "source_doc_no",
        "received_at", "company_id",
      ]);
      const scoped = lots.has("company_id") && Number.isFinite(Number(companyId));
      lotRows = await pg.unsafe(
        `SELECT ${lCols} FROM ${lots.q} WHERE product_code = $1${scoped ? " AND company_id = $2" : ""} ORDER BY received_at DESC LIMIT 25`,
        scoped ? [code, Number(companyId)] : [code],
      );
      const scope = scoped ? ", SO company" : "";
      line(`  (d) FIFO inventory_lots (latest ${lotRows.length}${scope}):`);
      for (const l of lotRows) {
        line(`      recv=${short(l.received_at, 20)}  qty=${l.qty_received}(rem ${l.qty_remaining})  unit_cost=${rm(l.unit_cost_sen)}  batch/PO=${short(l.batch_no, 18)}  src=${l.source_doc_type ?? "—"} ${short(l.source_doc_no, 20)}`);
        for (const s of stamped) {
          if (s > 0 && Number(l.unit_cost_sen ?? -1) === s) {
            verdicts.push(`${code}: NOTE — FIFO lot ${short(l.source_doc_no, 24)} carries the SAME unit cost ${rm(s)}; the SO column itself never reads lots, so an equal figure means the same master/GRN source fed both.`);
          }
        }
      }

      // e. each source GRN's currency/rate + line price + PI billing lines.
      const grnIds = [...new Set(lotRows.filter((l) => String(l.source_doc_type ?? "").toUpperCase() === "GRN" && l.source_doc_id).map((l) => l.source_doc_id))];
      if (grns && grnItems && grnIds.length > 0) {
        line(`  (e) source GRNs (${grnIds.length}) and their PI lines:`);
        for (const gid of grnIds) {
          const gCols = grns.sel(["grn_number", "currency", "exchange_rate", "received_at", "status"]);
          const g = (await pg.unsafe(`SELECT ${gCols} FROM ${grns.q} WHERE id = $1`, [gid]))[0];
          const rate = g && grns.has("exchange_rate") ? Number(g.exchange_rate ?? 1) : 1;
          line(`      GRN ${g?.grn_number ?? gid}  currency=${g?.currency ?? "MYR"}  exchange_rate=${g ? (g.exchange_rate ?? "—") : "—"}  status=${g?.status ?? "—"}`);
          const giCols = grnItems.sel(["id", "material_code", "qty_accepted", "unit_price_sen", "allocated_charge_sen"]);
          const gi = await pg.unsafe(
            `SELECT ${giCols} FROM ${grnItems.q} WHERE grn_id = $1 AND material_code = $2`, [gid, code],
          );
          for (const glr of gi) {
            const myr = Math.round(Number(glr.unit_price_sen ?? 0) * (Number.isFinite(rate) && rate > 0 ? rate : 1));
            line(`        GRN line: qty=${glr.qty_accepted}  price=${(Number(glr.unit_price_sen ?? 0) / 100).toFixed(2)} ${g?.currency ?? "MYR"}  (= ${rm(myr)} at rate)  freight_alloc=${rm(glr.allocated_charge_sen)}`);
            if (pi && piItems) {
              const piCols = piItems.sel(["purchase_invoice_id", "qty", "unit_price_sen", "allocated_charge_sen"]);
              const pil = await pg.unsafe(
                `SELECT ${piCols} FROM ${piItems.q} WHERE grn_item_id = $1`, [glr.id],
              );
              for (const pl of pil) {
                const phCols = pi.sel(["invoice_number", "status", "currency", "exchange_rate"]);
                const ph = (await pg.unsafe(`SELECT ${phCols} FROM ${pi.q} WHERE id = $1`, [pl.purchase_invoice_id]))[0];
                const prate = ph && pi.has("exchange_rate") ? Number(ph.exchange_rate ?? 1) : 1;
                const pMyr = Math.round(Number(pl.unit_price_sen ?? 0) * (Number.isFinite(prate) && prate > 0 ? prate : 1));
                line(`        PI ${ph?.invoice_number ?? pl.purchase_invoice_id}  [${ph?.status ?? "—"}]  qty=${pl.qty}  price=${(Number(pl.unit_price_sen ?? 0) / 100).toFixed(2)} ${ph?.currency ?? "MYR"}  rate=${ph?.exchange_rate ?? "—"}  -> landed ${rm(pMyr)}/unit  freight_alloc=${rm(pl.allocated_charge_sen)}`);
                for (const s of stamped) {
                  if (s > 0 && Number(pl.unit_price_sen ?? -1) === s && String(ph?.currency ?? "MYR").toUpperCase() !== "MYR") {
                    verdicts.push(`${code}: NOTE — PI ${ph?.invoice_number} bills ${ph?.currency} ${(s / 100).toFixed(2)}/unit, numerically equal to the stamped SO cost. If they share a source figure, the SO cost is a raw ${ph?.currency} number booked as RM.`);
                  }
                }
              }
            }
          }
        }
      } else {
        line("  (e) no GRN-sourced lots for this SKU (nothing has been received under this code) — consistent with a made-to-order line whose cost only exists as the master estimate.");
      }
    }

    // f. downstream DO/SI lines for these SO lines (the ②/③ actuals).
    const soItemIds = myLines.map((it) => it.id);
    if (doi && soItemIds.length > 0 && doi.has("so_item_id")) {
      const dCols = doi.sel(["delivery_order_id", "qty", "unit_cost_sen", "line_cost_sen", "ship_cost_sen"]);
      const dRows = await pg.unsafe(
        `SELECT ${dCols} FROM ${doi.q} WHERE so_item_id::text = ANY($1)`, [soItemIds.map(String)],
      );
      line(`  (f) DO lines serving these SO lines: ${dRows.length}`);
      for (const d of dRows) {
        let doNo = d.delivery_order_id;
        if (dos && d.delivery_order_id) {
          const dh = (await pg.unsafe(`SELECT ${dos.sel(["do_number", "status"])} FROM ${dos.q} WHERE id = $1`, [d.delivery_order_id]))[0];
          doNo = dh ? `${dh.do_number} [${dh.status}]` : doNo;
        }
        line(`      ${short(doNo, 34)}  qty=${d.qty}  live_cost=${rm(d.unit_cost_sen)}  ship_frozen=${doi.has("ship_cost_sen") ? rm(d.ship_cost_sen) : "n/a"}`);
      }
      if (dRows.length === 0) line("      (none — undelivered; the ② ship-time FIFO cost does not exist yet)");
    }
    if (sii && soItemIds.length > 0 && sii.has("so_item_id")) {
      const sCols = sii.sel(["sales_invoice_id", "qty", "unit_cost_sen", "line_cost_sen"]);
      const sRows = await pg.unsafe(
        `SELECT ${sCols} FROM ${sii.q} WHERE so_item_id::text = ANY($1)`, [soItemIds.map(String)],
      );
      line(`      SI lines billing these SO lines: ${sRows.length}`);
      for (const s of sRows) {
        let siNo = s.sales_invoice_id;
        if (sis && s.sales_invoice_id) {
          const sh = (await pg.unsafe(`SELECT ${sis.sel(["invoice_number", "status"])} FROM ${sis.q} WHERE id = $1`, [s.sales_invoice_id]))[0];
          siNo = sh ? `${sh.invoice_number} [${sh.status}]` : siNo;
        }
        line(`      ${short(siNo, 34)}  qty=${s.qty}  landed_cost=${rm(s.unit_cost_sen)}`);
      }
    }
    line("");
  }

  // ── [4] verdicts ──────────────────────────────────────────────────────────
  notice("=== VERDICT ===");
  if (verdicts.length === 0) {
    notice("No stamped figure matched any candidate source verbatim — compare the printed product-master fields, binding currency and GRN/PI landed units by eye; the divergent one is the answer.");
  }
  for (const v of verdicts) notice(v);
  notice("Reminder: mfg_sales_order_items.unit_cost_sen is the create-time PRODUCT-MASTER estimate (①). FIFO/GRN/PI actuals live on DO (②, ship_cost_sen) and SI (③) and are never written back to the SO.");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("check-sku-cost-trace failed:", e);
    await pg.end({ timeout: 5 });
    process.exit(1);
  });
