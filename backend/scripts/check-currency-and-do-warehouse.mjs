#!/usr/bin/env node
/* check-currency-and-do-warehouse — READ-ONLY. The two questions the owner's
 * 2026-09-07 rulings ask, answered against production instead of against a
 * migration file.
 *
 * RULING 1 — the foreign-currency purchase order. `HC-PO-009335` is CNY in
 * AutoCount and 'MYR' in the ERP, because `import-ac-outstanding-po.mjs:403`
 * writes the CONSTANT 'MYR'. That constant already cost RM 13,068.55 of
 * fabricated discount (docs/bugs/0665-*, reverted by #3070), because the
 * reconcile export carries the LOCAL (MYR) total while the ERP holds the
 * DOCUMENT one and the difference IS the exchange rate.
 *
 *   Book side, measured on the committed header cut (data/ac-doc-headers.json.gz,
 *   cut 2026-09-07 17:36+08): 22 CNY purchase orders out of 9,408, and 0 non-MYR
 *   sales orders out of 13,365. This job asks the ERP what it holds for those
 *   22 documents, what TYPE the currency column is (a text column and an enum
 *   are two different repairs), and — the blocker question — whether anything
 *   downstream would RE-INTERPRET the stored amount if the label changed.
 *
 * RULING 2 — the delivery line's location. AutoCount records a location per
 * DODTL row (`HQ`, `PG`, `KL`, `SRW`, `SBH`); the owner ruled these ARE the
 * ERP's own stock warehouses, not a new concept. This job asks whether
 * scm.delivery_order_items already has a column that could hold it — a column
 * that exists and is never written is this repo's likelier failure — and
 * whether the AutoCount line key needed to backfill it is populated.
 *
 * STRICTLY READ-ONLY. SELECT only: no DDL, no writes, no transaction, no marker
 * rows. Every interpolated identifier is a schema/table/column name discovered
 * from information_schema and re-validated against ^[a-z_][a-z0-9_]*$; no
 * caller input reaches any statement. Exits 0 for every legitimate answer — the
 * ANSWER is the output, not the exit code — and non-zero only when the database
 * is unreachable or a query errors.
 *
 * Mirrors backend/scripts/check-foreign-rate-one.mjs (the repo's read-only
 * diagnostic shape) and its workflow.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { SALESLOC } from "./lib/ac-stock-compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) {
  console.error("COMPANY_ID must be a positive integer");
  process.exit(1);
}

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return fs.readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const out = [];
const line = (m = "") => { out.push(m); console.log(m); };
const notice = (m) => { out.push(m); console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m); };

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`); return s; };
const qt = (schema, table) => `"${ident(schema)}"."${ident(table)}"`;
const rm = (sen) => (sen == null ? "-" : `RM ${(Number(sen) / 100).toFixed(2)}`);
const pad = (s, n) => String(s ?? "").padEnd(n);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const gz = (name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, name))));

async function schemaOf(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table} AND table_schema IN ('scm','public') AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r[0]?.table_schema ?? null;
}
async function colTypes(schema, table) {
  return pg`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}
     ORDER BY ordinal_position`;
}
async function enumLabels(udt) {
  const r = await pg`
    SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = ${udt} ORDER BY e.enumsortorder`;
  return r.map((x) => x.enumlabel);
}

/* the book side, from the committed cuts — no AutoCount round trip */
function bookCurrency() {
  const R = gz("ac-doc-headers.json.gz").rows;
  const pick = (fields, rows) => {
    const iC = fields.indexOf("CurrencyCode");
    const iD = fields.indexOf("DocNo");
    const iX = fields.indexOf("Cancelled");
    const tally = new Map();
    const foreign = [];
    for (const r of rows) {
      const cur = String(r[iC] ?? "").trim() || "(blank)";
      tally.set(cur, (tally.get(cur) ?? 0) + 1);
      if (cur !== "MYR") foreign.push({ docNo: String(r[iD] ?? "").trim(), cur, cancelled: r[iX] });
    }
    return { total: rows.length, tally, foreign };
  };
  return { exportedAt: R.exportedAt, so: pick(R.so_fields, R.so), po: pick(R.po_fields, R.po) };
}
function bookDoLocations() {
  const rows = gz("ac-partial-dos.json.gz");
  const byKey = new Map();
  const tally = new Map();
  for (const r of rows) {
    const loc = String(r.Location ?? "").trim();
    tally.set(loc || "(blank)", (tally.get(loc || "(blank)") ?? 0) + 1);
    if (r.DoDtlKey != null) byKey.set(String(r.DoDtlKey), { doNo: String(r.DoNo).trim(), loc });
  }
  return { rows: rows.length, docs: new Set(rows.map((r) => String(r.DoNo).trim())).size, byKey, tally };
}

async function main() {
  notice("=== CURRENCY + DELIVERY-LINE WAREHOUSE — READ-ONLY (no rows changed) ===");
  line(`company_id = ${CO}`);

  // ══════════ RULING 1 — currency ══════════
  line("");
  notice("--- RULING 1: the ERP says MYR on a document the book says is CNY ---");

  const book = bookCurrency();
  line(`book header cut: data/ac-doc-headers.json.gz, exported ${book.exportedAt}`);
  line(`  book SO: ${book.so.total} documents — ${[...book.so.tally].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  line(`  book PO: ${book.po.total} documents — ${[...book.po.tally].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  /* What TYPE is the currency column, table by table. A text column takes 'CNY'
     today; an enum needs the label added first, and ALTER TYPE ... ADD VALUE
     cannot be used in the same transaction that writes it. */
  const CURRENCY_TABLES = [
    "purchase_orders", "mfg_sales_orders", "delivery_orders", "grns",
    "purchase_invoices", "payment_vouchers", "sales_invoices",
  ];
  line("");
  line("currency column, per table (the repair depends on the TYPE):");
  const enumsSeen = new Map();
  for (const t of CURRENCY_TABLES) {
    const s = await schemaOf(t);
    if (!s) { line(`  ${pad(t, 20)} TABLE NOT FOUND in scm or public`); continue; }
    const cols = await colTypes(s, t);
    const cur = cols.find((c) => c.column_name === "currency");
    const rate = cols.find((c) => c.column_name === "exchange_rate");
    if (!cur) { line(`  ${s}.${pad(t, 20)} no currency column`); continue; }
    if (cur.data_type === "USER-DEFINED") enumsSeen.set(cur.udt_name, await enumLabels(cur.udt_name));
    line(
      `  ${s}.${pad(t, 20)} currency ${cur.data_type}` +
        `${cur.data_type === "USER-DEFINED" ? ` (${cur.udt_name})` : ""}` +
        ` default=${cur.column_default ?? "-"}` +
        `${rate ? `  exchange_rate ${rate.data_type}` : "  NO exchange_rate column"}`,
    );
  }
  for (const [name, labels] of enumsSeen) {
    line(`  ENUM ${name} labels: ${labels.join(", ")}${labels.includes("CNY") ? "" : "   <- 'CNY' IS NOT A LABEL"}`);
  }

  const curSchema = await schemaOf("currencies");
  if (curSchema) {
    const rows = await pg.unsafe(
      `SELECT code, name, rate_to_myr, is_active, company_id FROM ${qt(curSchema, "currencies")} ORDER BY code`,
    );
    line("");
    line(`currency master (${curSchema}.currencies): ${rows.length} row(s)`);
    for (const r of rows) {
      line(`  ${pad(r.code, 6)} ${pad(r.name, 22)} rate_to_myr=${r.rate_to_myr} active=${r.is_active} company=${r.company_id ?? "-"}`);
    }
  }

  line("");
  line("distinct currency values the ERP holds today:");
  for (const t of ["purchase_orders", "mfg_sales_orders", "delivery_orders", "grns", "purchase_invoices"]) {
    const s = await schemaOf(t);
    if (!s) continue;
    const cols = await colTypes(s, t);
    if (!cols.some((c) => c.column_name === "currency")) continue;
    const hasCo = cols.some((c) => c.column_name === "company_id");
    const rows = await pg.unsafe(
      `SELECT currency::text AS currency, COUNT(*)::int AS n FROM ${qt(s, t)}` +
        (hasCo ? ` WHERE company_id = ${CO}` : "") +
        " GROUP BY 1 ORDER BY 2 DESC",
    );
    line(`  ${s}.${pad(t, 20)} ${rows.map((r) => `${r.currency ?? "(null)"}=${r.n}`).join(", ")}`);
  }

  // The 22 — what the ERP holds for each.
  const foreignNos = book.po.foreign.map((f) => f.docNo);
  line("");
  line(`the ${foreignNos.length} foreign purchase orders, book vs ERP:`);
  let inErp = 0;
  let wrongLabel = 0;
  const erpPoByAc = new Map();
  if (foreignNos.length) {
    const rows = await pg`
      SELECT id::text AS id, po_number, linked_ac_docno, currency::text AS currency, status,
             total_sen, subtotal_sen, company_id
        FROM scm.purchase_orders
       WHERE linked_ac_docno = ANY(${foreignNos}::text[])
       ORDER BY linked_ac_docno`;
    for (const r of rows) erpPoByAc.set(String(r.linked_ac_docno).trim(), r);
    for (const f of book.po.foreign) {
      const e = erpPoByAc.get(f.docNo);
      if (!e) { line(`  ${pad(f.docNo, 14)} book ${f.cur}  — NOT IN THE ERP (outside the migrated scope)`); continue; }
      inErp += 1;
      const wrong = String(e.currency ?? "").toUpperCase() !== f.cur.toUpperCase();
      if (wrong) wrongLabel += 1;
      line(
        `  ${pad(f.docNo, 14)} book ${f.cur}  ERP ${pad(e.currency ?? "(null)", 6)}` +
          `${wrong ? "MISLABELLED" : "ok         "}  ${pad(e.po_number, 16)} ${pad(e.status, 20)} total ${rm(e.total_sen)}`,
      );
    }
  }
  notice(
    `RULING 1 SIZE: the book holds ${book.po.foreign.length} non-MYR purchase orders out of ${book.po.total}, ` +
      `and ${book.so.foreign.length} non-MYR sales orders out of ${book.so.total}. ` +
      `${inErp} of the ${book.po.foreign.length} are in the ERP; ${wrongLabel} of those carry the wrong currency label.`,
  );

  /* THE BLOCKER QUESTION: does anything RE-INTERPRET the stored amount when the
     label changes? A purchase order carries no exchange_rate at all — the rate
     lives on the GRN / PI / PV, which convert with their OWN currency and rate
     (backend/src/scm/lib/fx.ts). So the exposure is the DOWNSTREAM documents of
     these purchase orders, not the orders themselves. Count them. */
  line("");
  line("downstream of those purchase orders (what a label change could reach):");
  const poIds = [...erpPoByAc.values()].map((r) => r.id);
  if (poIds.length) {
    const grns = await pg`
      SELECT g.id::text AS id, g.grn_number, g.currency::text AS currency, g.exchange_rate, g.status
        FROM scm.grns g WHERE g.purchase_order_id = ANY(${poIds}::uuid[])
       ORDER BY g.grn_number`;
    line(`  GRNs: ${grns.length}`);
    for (const g of grns.slice(0, 40)) {
      line(`    ${pad(g.grn_number, 20)} ${pad(g.currency ?? "(null)", 6)} rate=${g.exchange_rate} ${g.status}`);
    }
    const pis = await pg`
      SELECT p.id::text AS id, p.invoice_number, p.currency::text AS currency, p.exchange_rate, p.status
        FROM scm.purchase_invoices p WHERE p.purchase_order_id = ANY(${poIds}::uuid[])
       ORDER BY p.invoice_number`;
    line(`  Purchase invoices: ${pis.length}`);
    for (const p of pis.slice(0, 40)) {
      line(`    ${pad(p.invoice_number, 20)} ${pad(p.currency ?? "(null)", 6)} rate=${p.exchange_rate} ${p.status}`);
    }
    if (grns.length) {
      const lots = await pg`
        SELECT COUNT(*)::int AS n FROM scm.inventory_lots
         WHERE source_doc_type = 'GRN' AND source_doc_id = ANY(${grns.map((g) => g.id)}::uuid[])`;
      line(`  FIFO lots opened by those GRNs: ${lots[0]?.n ?? 0}`);
    }
  } else {
    line("  (no ERP purchase orders matched, nothing downstream)");
  }

  // ══════════ RULING 2 — the delivery line's warehouse ══════════
  line("");
  notice("--- RULING 2: AutoCount records a location per delivery LINE; where does the ERP hold it? ---");

  const diSchema = await schemaOf("delivery_order_items");
  const dhSchema = await schemaOf("delivery_orders");
  if (!diSchema) {
    notice("FATAL — scm.delivery_order_items not found. (Missing-table condition, not a data answer.)");
  } else {
    const diCols = await colTypes(diSchema, "delivery_order_items");
    line(`${diSchema}.delivery_order_items — ${diCols.length} columns:`);
    line(`  ${diCols.map((c) => c.column_name).join(", ")}`);
    const candidates = diCols.filter((c) => /warehouse|location|rack|branch|site|store/.test(c.column_name));
    line(
      candidates.length
        ? `  columns that could already hold a warehouse: ${candidates.map((c) => `${c.column_name} (${c.data_type})`).join(", ")}`
        : "  NO column on the delivery line names a warehouse, a location, or a branch.",
    );
    for (const c of candidates) {
      const r = await pg.unsafe(
        `SELECT COUNT(*)::int AS total, COUNT(${ident(c.column_name)})::int AS filled FROM ${qt(diSchema, "delivery_order_items")}`,
      );
      line(`    ${c.column_name}: ${r[0].filled} of ${r[0].total} rows carry a value`);
    }
    if (dhSchema) {
      const dhCols = await colTypes(dhSchema, "delivery_orders");
      const hdr = dhCols.filter((c) => /warehouse|location|branch|site/.test(c.column_name));
      line(
        hdr.length
          ? `${dhSchema}.delivery_orders warehouse-ish columns: ${hdr.map((c) => `${c.column_name} (${c.data_type})`).join(", ")}`
          : `${dhSchema}.delivery_orders has no warehouse/location column either.`,
      );
    }

    /* The warehouse master the map must resolve INTO. backfill-so-line-warehouse
       resolves through `code`, not `name`, so BOTH are printed — a map that
       resolves against the wrong column is how stock moves between branches. */
    const whSchema = await schemaOf("warehouses");
    if (whSchema) {
      const whCols = await colTypes(whSchema, "warehouses");
      const has = (n) => whCols.some((c) => c.column_name === n);
      const sel = ["id::text AS id"];
      for (const c of ["code", "name", "company_id", "is_active"]) if (has(c)) sel.push(ident(c));
      const whs = await pg.unsafe(
        `SELECT ${sel.join(", ")} FROM ${qt(whSchema, "warehouses")} ORDER BY ${has("company_id") ? "company_id, " : ""}id`,
      );
      const byCode = new Map();
      const byName = new Map();
      line("");
      line(`${whSchema}.warehouses — ${whs.length} row(s) (columns: ${whCols.map((c) => c.column_name).join(", ")}):`);
      for (const w of whs) {
        line(`  code=${pad(w.code, 22)} name=${pad(w.name, 22)} company=${w.company_id ?? "-"}  ${w.id}`);
        if (!has("company_id") || Number(w.company_id) === CO) {
          if (w.code) byCode.set(String(w.code).trim().toUpperCase(), w.id);
          if (w.name) byName.set(String(w.name).trim().toUpperCase(), w.id);
        }
      }
      line("");
      line(`the SHARED SALESLOC map (lib/ac-stock-compare.mjs) resolved against company ${CO}:`);
      for (const [code, name] of Object.entries(SALESLOC)) {
        const k = name.toUpperCase();
        line(
          `  ${pad(code, 10)} -> ${pad(name, 22)} by code=${byCode.get(k) ?? "-"}  by name=${byName.get(k) ?? "-"}` +
            `${byCode.has(k) || byName.has(k) ? "" : "   UNRESOLVED — do not guess"}`,
        );
      }
    }

    const bd = bookDoLocations();
    line("");
    line(`book delivery lines in the cutover cut (data/ac-partial-dos.json.gz): ${bd.rows} lines across ${bd.docs} documents`);
    line(`  location distribution: ${[...bd.tally].map(([k, v]) => `${k}=${v}`).join(", ")}`);

    if (diCols.some((c) => c.column_name === "linked_ac_dtlkey")) {
      const k = await pg`
        SELECT COUNT(*)::int AS lines, COUNT(i.linked_ac_dtlkey)::int AS keyed
          FROM scm.delivery_order_items i
          JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
         WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
      line(`  ERP migrated delivery lines: ${k[0].lines}; carrying linked_ac_dtlkey: ${k[0].keyed}`);
      const keys = [...bd.byKey.keys()];
      if (keys.length) {
        const hit = await pg`
          SELECT COUNT(*)::int AS n FROM scm.delivery_order_items i
            JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
           WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey::text = ANY(${keys}::text[])`;
        line(`  ERP lines whose linked_ac_dtlkey matches a book DODTL row in the cut: ${hit[0].n}`);
      }
    } else {
      line("  delivery_order_items has NO linked_ac_dtlkey column — a backfill would need the document + item join.");
    }

    const docs = await pg`
      SELECT h.linked_ac_docno AS ac, COUNT(i.id)::int AS lines
        FROM scm.delivery_orders h
        JOIN scm.delivery_order_items i ON i.delivery_order_id = h.id
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
       GROUP BY 1`;
    const bookDocs = new Set([...bd.byKey.values()].map((v) => v.doNo));
    const matched = docs.filter((d) => bookDocs.has(String(d.ac).trim()));
    line(
      `  migrated ERP delivery documents: ${docs.length} (${docs.reduce((s, d) => s + d.lines, 0)} lines); ` +
        `of those, ${matched.length} appear in the book cut (${matched.reduce((s, d) => s + d.lines, 0)} lines)`,
    );
  }

  line("");
  notice("=== END — nothing was written ===");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + out.join("\n") + "\n```\n");
  }
}

main()
  .then(() => pg.end())
  .catch(async (e) => {
    console.error(e);
    await pg.end().catch(() => {});
    process.exit(1);
  });
