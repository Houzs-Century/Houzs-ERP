#!/usr/bin/env node
// ----------------------------------------------------------------------------
// Which ERP item codes cannot resolve to ONE AutoCount item, and what the ERP
// already knows that would settle each one.
//
// WHY THIS EXISTS. The cutover collapsed supplier-specific AutoCount items onto
// one ERP code — "9028-1S" came from two, "SQUARE PILLOW" from five. A purchase
// order names its creditor and resolves; a SALES ORDER names none, so every
// ambiguous code refuses the whole document (D10, ItemCodeError). The first
// order saved after the write-back went live, HC-SO-2608-001, died exactly
// this way.
//
// The remedy is a scm.supplier_material_bindings row naming the AutoCount item
// — resolveAcItemCode checks bindings FIRST and returns on a hit. This report
// says, per ambiguous code: what the account book's candidates are, what
// bindings already exist, which supplier the ERP calls the main one, and
// therefore whether the code resolves today.
//
// READ-ONLY. One SELECT per question, no writes. Run it before and after
// set-autocount-item-binding.mjs.
// ----------------------------------------------------------------------------
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(join(here, "..", ".dev.vars"), "utf8");
    const m = raw.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const COMPANY = Number(process.env.COMPANY_ID ?? 1);
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/* The compiled cutover map, parsed from the generated module rather than the
   CSV: the CSV is not shipped to the Worker and this must agree with what the
   resolver actually loads. */
const TSV = readFileSync(join(here, "..", "src", "services", "autocount-item-map.ts"), "utf8")
  .match(/`([\s\S]*?)`/)[1];

const byErp = new Map();
for (const line of TSV.split("\n")) {
  if (!line) continue;
  const [ac, erp, category, supplier] = line.split("\t");
  if (!ac || !erp) continue;
  const k = erp.trim().toUpperCase();
  if (!byErp.has(k)) byErp.set(k, []);
  byErp.get(k).push({ ac, category: category ?? "", supplier: supplier || null });
}

const ambiguous = [...byErp.entries()].filter(([, v]) => v.length > 1);
/* A sofa's compartments collapse to a synthesised `<model>-1S` before the
   resolver runs, so the base code is what a binding must be keyed by — and it
   is never an ERP line code, which is why these are called out separately. */
const isSofaBase = (code) => /-1S$/.test(code);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  notice(
    `cutover map: ${byErp.size} distinct ERP codes, ${ambiguous.length} of them ambiguous ` +
      `(${ambiguous.filter(([k]) => isSofaBase(k)).length} sofa base codes). ` +
      `Every ambiguous code refuses any SALES ORDER that contains it unless a binding names the item.`,
  );

  const codes = ambiguous.map(([k]) => k);
  const [bindings, sofaModelRows] = await Promise.all([
    pg`SELECT b.material_code, b.supplier_sku, b.is_main_supplier,
              s.code AS supplier_code, s.name AS supplier_name
         FROM scm.supplier_material_bindings b
         LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
        WHERE b.company_id = ${COMPANY}
          AND b.material_kind = 'mfg_product'
          AND upper(btrim(b.material_code)) = ANY(${codes})
        ORDER BY b.material_code, b.is_main_supplier DESC`,
    /* For a sofa base code no ERP line ever carries, the ERP's own opinion of
       the supplier lives on the COMPARTMENT rows (9028-1A(LHF) and friends).
       That is the fact that decides which candidate is right, so read it
       rather than asking a human to pick. */
    pg`SELECT upper(split_part(btrim(b.material_code), '-', 1)) AS model,
              s.code AS supplier_code, s.name AS supplier_name,
              bool_or(b.is_main_supplier) AS is_main,
              count(*)::int AS lines
         FROM scm.supplier_material_bindings b
         LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
        WHERE b.company_id = ${COMPANY}
          AND b.material_kind = 'mfg_product'
          AND upper(split_part(btrim(b.material_code), '-', 1)) = ANY(${
            ambiguous.filter(([k]) => isSofaBase(k)).map(([k]) => k.replace(/-1S$/, ""))
          })
        GROUP BY 1, 2, 3
        ORDER BY 1, bool_or(b.is_main_supplier) DESC, count(*) DESC`,
  ]);

  const boundFor = new Map();
  for (const r of bindings) {
    const k = String(r.material_code).trim().toUpperCase();
    if (!boundFor.has(k)) boundFor.set(k, []);
    boundFor.get(k).push(r);
  }

  /* Sofas first and in full: they are the ones no data entry could fix until
     the binding lookup was taught the base code, so they are what an operator
     is here to act on. */
  notice("");
  notice("=== AMBIGUOUS SOFA MODELS — a sales order containing one is refused ===");
  for (const [code, cands] of ambiguous.filter(([k]) => isSofaBase(k))) {
    const model = code.replace(/-1S$/, "");
    notice(`${code}`);
    for (const c of cands) notice(`    candidate: ${c.ac}   [supplier ${c.supplier ?? "none"}]`);
    const bound = (boundFor.get(code) ?? []).filter((b) => (b.supplier_sku ?? "").trim());
    if (bound.length) {
      for (const b of bound) {
        notice(`    BOUND -> ${b.supplier_sku}  via ${b.supplier_code ?? "?"} ${b.supplier_name ?? ""}${b.is_main_supplier ? " (MAIN)" : ""}`);
      }
      notice(`    => RESOLVES to ${bound[0].supplier_sku}`);
    } else {
      notice("    BOUND -> nothing. This code refuses every sales order it appears on.");
      const who = sofaModelRows.filter((r) => r.model === model);
      if (who.length) {
        notice(`    the ERP's own supplier for model ${model}, from its compartment rows:`);
        for (const r of who) {
          const match = cands.find((c) => c.supplier === r.supplier_code);
          notice(
            `      ${r.supplier_code ?? "?"} ${r.supplier_name ?? ""}` +
              `${r.is_main ? " (MAIN)" : ""} — ${r.lines} line(s)` +
              (match ? `  => matches candidate ${match.ac}` : "  => matches no candidate"),
          );
        }
        const main = who.find((r) => r.is_main) ?? who[0];
        const pick = cands.find((c) => c.supplier === main?.supplier_code);
        if (pick) notice(`    SUGGESTED: bind ${code} -> ${pick.ac}`);
        else notice("    SUGGESTED: none — no candidate belongs to the supplier the ERP records. Needs a human.");
      } else {
        notice(`    the ERP has no supplier binding for any ${model} compartment either. Needs a human.`);
      }
    }
  }

  /* Non-sofa ambiguity is summarised, not listed line by line: 113 codes is a
     wall of text, and the binding path already worked for them. What matters
     is how many are still unresolved. */
  const others = ambiguous.filter(([k]) => !isSofaBase(k));
  const unresolved = others.filter(([k]) => !(boundFor.get(k) ?? []).some((b) => (b.supplier_sku ?? "").trim()));
  notice("");
  notice(
    `=== OTHER AMBIGUOUS CODES: ${others.length} total, ${others.length - unresolved.length} bound, ` +
      `${unresolved.length} still unresolved ===`,
  );
  for (const [code, cands] of unresolved) {
    notice(`  ${code} -> ${cands.map((c) => `${c.ac} [${c.supplier ?? "none"}]`).join("  |  ")}`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
