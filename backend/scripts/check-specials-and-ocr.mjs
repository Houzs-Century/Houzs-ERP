// Read-only evidence for three questions the owner asked on 2026-08-10, none of
// which can be answered from the tree because every fact lives in production.
//
//   Q1  Do the special orders the backfill wrote show up as ACTUAL SELECTIONS
//       in the line's Special Orders picker, and is that picker multi-select?
//       The picker binds to variants.specials (SpecialOrders.tsx line 91); the
//       backfill wrote custom_specials. This prints BOTH fields for the same
//       lines so the divergence is a fact, not a reading of the code.
//
//   Q2  Did the hand-written sofa sketch rules actually land? The reserved
//       so_scan_rules row '__GLOBAL_MANUAL__' is printed with its length and
//       non-empty line count so it can be compared to what was written.
//
//   Q3  Did the APPLY run do what its dry-run promised (498 matched / 164 free
//       / 375 SO + 103 PO lines)? Counted here off the live rows, classifying
//       every array element against the LIVE scm.special_addons SOFA pool.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — the answer IS the output; only an unreachable database
// or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const CO = Number(process.env.COMPANY || 1);

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

const log = (m) => console.log(m);
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const K = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** variants.specials (array | legacy singular string) -> code list, EXACTLY the
 *  normalisation SpecialOrders.tsx `specialsList` applies. */
const specialsList = (v) => {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v) return [v];
  return [];
};

/** One element of custom_specials -> its display string. Mirrors
 *  SalesOrderDetailListing.formatSpecials: the column holds plain strings on
 *  some rows and { description | label } objects on others. */
const elText = (el) => {
  if (el == null) return "";
  if (typeof el === "string") return el;
  if (typeof el === "object") {
    const v = el.label ?? el.description ?? el.name ?? el.value;
    return typeof v === "string" ? v : "";
  }
  return "";
};

try {
  // ==========================================================================
  // Q2 — the hand-written OCR rules row
  // ==========================================================================
  log("");
  log("================ Q2  scm.so_scan_rules reserved rows ================");
  const RESERVED = ["__GLOBAL__", "__GLOBAL_RULES__", "__GLOBAL_MANUAL__"];
  const ruleRows = await pg`
    SELECT salesperson, rules, sample_count, updated_at
      FROM scm.so_scan_rules
     WHERE salesperson = ANY(${RESERVED})
     ORDER BY salesperson`;
  if (ruleRows.length === 0) {
    notice("Q2: NO reserved __*__ rows in scm.so_scan_rules at all.");
  }
  // Counted in JS, not SQL: the line count must be the SAME arithmetic the seed
  // script printed when it wrote the row, or the comparison proves nothing.
  const lineStats = (t) => ({
    chars: t.length,
    nonEmpty: t.split("\n").filter((l) => l.trim() !== "").length,
    total: t.split("\n").length,
  });
  for (const r of ruleRows) {
    const s = lineStats(r.rules ?? "");
    log(`  ${r.salesperson.padEnd(20)} chars=${s.chars}  nonEmptyLines=${s.nonEmpty}  sample_count=${r.sample_count ?? "null"}  updated_at=${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  }

  const manual = ruleRows.find((r) => r.salesperson === "__GLOBAL_MANUAL__");
  if (!manual) {
    notice("Q2 VERDICT: __GLOBAL_MANUAL__ row is MISSING. The injection reads nothing.");
  } else {
    const text = manual.rules ?? "";
    const s = lineStats(text);
    notice(`Q2: __GLOBAL_MANUAL__ present — ${s.chars} chars, ${s.nonEmpty} non-empty lines (of ${s.total} total).`);
    log("  --- first 3 non-empty lines, for identification ---");
    for (const l of text.split("\n").filter((x) => x.trim() !== "").slice(0, 3)) {
      log(`    | ${l.slice(0, 150)}`);
    }
  }

  // Total row count, so "reserved rows are not enumerated as salespeople" can
  // be checked against the real listing size.
  const [{ n: ruleTotal }] = await pg`SELECT count(*)::int AS n FROM scm.so_scan_rules`;
  log(`  so_scan_rules total rows: ${ruleTotal} (reserved: ${ruleRows.length}, per-rep: ${ruleTotal - ruleRows.length})`);

  // ==========================================================================
  // The live SOFA picker pool — every classification below resolves against it
  // ==========================================================================
  const addons = await pg`
    SELECT code, label, categories, active, selling_price_sen
      FROM scm.special_addons WHERE company_id = ${CO}`;
  const sofaAddons = addons.filter((r) => (r.categories || []).some((c) => /sofa/i.test(String(c))));
  const live = new Map();
  for (const r of sofaAddons) {
    live.set(K(r.code), r.code);
    if (r.label) live.set(K(r.label), r.code);
  }
  log("");
  log(`  live scm.special_addons: ${addons.length} rows, SOFA category: ${sofaAddons.length}`);
  /* The selling surcharge decides whether moving these picks into
     variants.specials could ever RE-PRICE a migrated line: the recompute reads
     sellingPriceSen off exactly these rows. All zero => the fix is price-inert
     today, and the risk is only that pricing them later moves migrated totals. */
  const priced = sofaAddons.filter((r) => Number(r.selling_price_sen ?? 0) !== 0);
  log(`  SOFA add-ons with a NON-ZERO selling surcharge: ${priced.length}`);
  for (const r of priced) log(`     ${String(r.selling_price_sen).padStart(8)} sen  ${r.code}`);

  // ==========================================================================
  // Q1 + Q3 — the backfilled lines
  // ==========================================================================
  const soLines = await pg`
    SELECT i.id, h.doc_no, i.item_code AS code, i.description2 AS d2,
           i.custom_specials, i.variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await pg`
    SELECT i.id, h.doc_no, i.material_code AS code, i.description2 AS d2,
           i.custom_specials, i.variants
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;

  const report = (name, rows) => {
    let withSpecials = 0, elements = 0, codeEls = 0, freeEls = 0;
    let withVariantSpecials = 0, variantCodeEls = 0;
    let objShaped = 0, strShaped = 0;
    for (const r of rows) {
      const cs = Array.isArray(r.custom_specials) ? r.custom_specials : [];
      if (cs.length) withSpecials++;
      for (const el of cs) {
        elements++;
        if (typeof el === "string") strShaped++;
        else if (el && typeof el === "object") objShaped++;
        const t = elText(el);
        if (t && live.has(K(t))) codeEls++;
        else freeEls++;
      }
      const vs = specialsList(r.variants?.specials ?? r.variants?.special);
      if (vs.length) withVariantSpecials++;
      for (const c of vs) if (live.has(K(c))) variantCodeEls++;
    }
    log("");
    log(`  ${name}: ${rows.length} migrated sofa lines in scope`);
    log(`     custom_specials non-empty ............... ${withSpecials} lines, ${elements} elements`);
    log(`        elements that ARE a live picker code . ${codeEls}`);
    log(`        elements that are free text .......... ${freeEls}`);
    log(`        element shape: ${strShaped} plain strings, ${objShaped} objects`);
    log(`     variants.specials non-empty (what the`);
    log(`        picker actually reads) ............... ${withVariantSpecials} lines, ${variantCodeEls} live codes`);
    return { withSpecials, elements, codeEls, freeEls, withVariantSpecials, strShaped, objShaped };
  };

  log("");
  log("========= Q1 + Q3  custom_specials (written) vs variants.specials (read) =========");
  const so = report("SO  scm.mfg_sales_order_items", soLines);
  const po = report("PO  scm.purchase_order_items", poLines);

  log("");
  notice(`Q3: lines carrying custom_specials — SO ${so.withSpecials} (dry-run promised 375), PO ${po.withSpecials} (promised 103).`);
  notice(`Q3: elements matching a live picker code ${so.codeEls + po.codeEls} (dry-run promised 498 matched); free text ${so.freeEls + po.freeEls} (promised 164).`);
  notice(`Q1: lines whose variants.specials is non-empty — SO ${so.withVariantSpecials}, PO ${po.withVariantSpecials}. This is what the picker renders as ticked.`);

  // ==========================================================================
  // Q1 — three real lines, both fields side by side
  // ==========================================================================
  log("");
  log("================ Q1  three real backfilled SO lines ================");
  const samples = soLines
    .filter((r) => Array.isArray(r.custom_specials) && r.custom_specials.length >= 2)
    .slice(0, 3);
  if (samples.length === 0) log("  (no SO line carries 2+ custom_specials entries)");
  for (const r of samples) {
    const vs = specialsList(r.variants?.specials ?? r.variants?.special);
    log("");
    log(`  ${r.doc_no}  line id ${r.id}  item ${r.code}`);
    log(`    description2      : ${String(r.d2 ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
    log(`    custom_specials   : ${JSON.stringify(r.custom_specials)}`);
    log(`    variants.specials : ${JSON.stringify(r.variants?.specials ?? r.variants?.special ?? null)}`);
    log(`    variants keys     : ${Object.keys(r.variants ?? {}).sort().join(", ") || "(none)"}`);
    log(`    -> picker would show (${vs.length} selected)`);
  }

  log("");
  await pg.end();
  process.exit(0);
} catch (e) {
  console.error("check failed:", e.message);
  try { await pg.end(); } catch { /* ignore */ }
  process.exit(1);
}
