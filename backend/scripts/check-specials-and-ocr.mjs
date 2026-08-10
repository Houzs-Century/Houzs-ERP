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

    /* BOTH product families must be in the LIVE row, not just the sofa half the
       original task was about: a later overwrite that dropped one would still
       satisfy a char-count check. Sections are the ALL-CAPS header lines; the
       quoted line is pulled OUT OF the live text rather than hard-coded, so the
       quote is evidence and not a restatement of the seed script. */
    const lines = text.split("\n");
    const isHeader = (t) => t !== "" && t === t.toUpperCase() && /[A-Z]/.test(t) && !/^\s*[-\d]/.test(t);
    const sectionsFor = (fam) => {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!isHeader(t) || !new RegExp(`^${fam}\\b`).test(t)) continue;
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          const u = lines[j].trim();
          if (isHeader(u) && !new RegExp(`^${fam}\\b`).test(u)) { end = j; break; }
        }
        out.push({ header: t, body: lines.slice(i + 1, end).map((l) => l.trim()) });
      }
      return out;
    };
    // "Distinctive" = the longest substantive line, which is always a rule.
    const distinctive = (sec) =>
      sec.body.filter((l) => l.length > 40).sort((a, b) => b.length - a.length)[0] ?? "(section body is empty)";
    log("  --- family sections present in the LIVE row ---");
    for (const fam of ["SOFA", "BEDFRAME"]) {
      const secs = sectionsFor(fam);
      if (secs.length === 0) {
        notice(`Q3: ${fam} section is ABSENT from the live __GLOBAL_MANUAL__ row.`);
        continue;
      }
      log(`    ${fam}: ${secs.length} section(s) — ${secs.map((s) => s.header).join(" | ")}`);
      log(`      quote: ${distinctive(secs[0]).slice(0, 220)}`);
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
  /* STRICT, case-SENSITIVE token membership. The picker's pool is built by
     exact match on the family token, so a row tagged 'sofa' is NOT a sofa row
     to the UI — matching case-insensitively here would hide precisely the
     defect this check exists to find. */
  const hasToken = (r, tok) => (r.categories || []).map(String).includes(tok);
  const sofaAddons = addons.filter((r) => hasToken(r, "SOFA"));
  const bedAddons = addons.filter((r) => hasToken(r, "BEDFRAME"));
  const live = new Map();
  for (const r of sofaAddons) {
    live.set(K(r.code), r.code);
    if (r.label) live.set(K(r.label), r.code);
  }
  // Second pool so a BEDFRAME-tagged code on a bedframe line reads as REAL
  // rather than being reported as an orphan.
  const liveBed = new Map();
  for (const r of bedAddons) {
    liveBed.set(K(r.code), r.code);
    if (r.label) liveBed.set(K(r.label), r.code);
  }
  const byCodeKey = new Map(addons.map((r) => [K(r.code), r]));

  log("");
  log(`  live scm.special_addons: ${addons.length} rows — exact 'SOFA': ${sofaAddons.length}, exact 'BEDFRAME': ${bedAddons.length}`);

  // ---- categories-array hygiene: what a case-insensitive match would hide ---
  const emptyCats = addons.filter((r) => !Array.isArray(r.categories) || r.categories.length === 0);
  const caseOffenders = addons.filter((r) => (r.categories || []).map(String)
    .some((c) => c !== c.toUpperCase() && /^(sofa|bedframe|mattress)$/i.test(c)));
  log(`  rows with an EMPTY categories array ....... ${emptyCats.length}`);
  for (const r of emptyCats.slice(0, 40)) log(`     EMPTY-CATS  ${r.code}  (${r.label ?? "no label"})`);
  log(`  rows with a NON-UPPER-CASE family token ... ${caseOffenders.length}`);
  for (const r of caseOffenders.slice(0, 40)) log(`     CASE  ${r.code}  categories=${JSON.stringify(r.categories)}`);
  const tokenTally = new Map();
  for (const r of addons) for (const c of (r.categories || []).map(String)) tokenTally.set(c, (tokenTally.get(c) || 0) + 1);
  log(`  distinct category tokens in use: ${[...tokenTally.entries()].sort().map(([t, n]) => `${t}=${n}`).join("  ") || "(none)"}`);
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
  /* Population = the backfill's OWN scope (migrated sofa) UNION every line that
     actually carries a custom_specials array, whatever its item_group or
     origin. The union is the point: scoping the audit to the same filter the
     backfill used would make a code stamped on a bedframe line, or on a line
     outside the migrated set, invisible to the check meant to find orphans. */
  const soLines = await pg`
    SELECT i.id, h.doc_no, i.item_code AS code, i.item_group, i.description2 AS d2,
           i.custom_specials, i.variants,
           (h.linked_ac_docno IS NOT NULL) AS migrated
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND ( (i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL)
             OR (jsonb_typeof(i.custom_specials) = 'array'
                 AND jsonb_array_length(i.custom_specials) > 0) )`;
  // The PO header numbers itself `po_number`; only mfg_sales_orders has doc_no.
  const poLines = await pg`
    SELECT i.id, h.po_number AS doc_no, i.material_code AS code, i.item_group, i.description2 AS d2,
           i.custom_specials, i.variants,
           (h.linked_ac_docno IS NOT NULL) AS migrated
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO}
       AND ( (i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL)
             OR (jsonb_typeof(i.custom_specials) = 'array'
                 AND jsonb_array_length(i.custom_specials) > 0) )`;

  /* Q2 — is every stamped element a REAL add-on? An element is an ORPHAN when
     its text resolves to no special_addons row at all; WRONG-FAMILY when the
     row exists but is not tagged with the family the line belongs to. */
  const famOf = (r) => (String(r.item_group || "").toUpperCase() === "BEDFRAME" ? "BEDFRAME" : "SOFA");
  const orphans = new Map();
  const wrongFamily = new Map();
  const auditElements = (rows) => {
    for (const r of rows) {
      const cs = Array.isArray(r.custom_specials) ? r.custom_specials : [];
      const pool = famOf(r) === "BEDFRAME" ? liveBed : live;
      for (const el of cs) {
        const t = elText(el);
        if (!t || pool.has(K(t))) continue;
        const row = byCodeKey.get(K(t));
        if (row) {
          const key = `${row.code} categories=${JSON.stringify(row.categories)} (line family ${famOf(r)})`;
          wrongFamily.set(key, (wrongFamily.get(key) || 0) + 1);
        } else {
          orphans.set(t, (orphans.get(t) || 0) + 1);
        }
      }
    }
  };

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
    const backfillScope = rows.filter((r) => r.migrated && String(r.item_group) === "sofa").length;
    const groups = new Map();
    for (const r of rows) {
      if (!Array.isArray(r.custom_specials) || r.custom_specials.length === 0) continue;
      const g = `${r.item_group ?? "null"}/${r.migrated ? "migrated" : "native"}`;
      groups.set(g, (groups.get(g) || 0) + 1);
    }
    log("");
    log(`  ${name}: ${rows.length} lines in scope (${backfillScope} inside the backfill's own migrated-sofa filter)`);
    log(`     lines with custom_specials, by item_group/origin: ${[...groups.entries()].sort().map(([g, n]) => `${g}=${n}`).join("  ") || "(none)"}`);
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

  // ==========================================================================
  // Q2 — are the stamped codes REAL? Orphans + wrong-family, strict token.
  // ==========================================================================
  auditElements(soLines);
  auditElements(poLines);
  log("");
  log("=========== Q2  stamped elements vs scm.special_addons (strict token) ===========");
  log(`  element texts resolving to NO special_addons row (orphan / free text): ${orphans.size} distinct`);
  for (const [t, n] of [...orphans.entries()].sort((a, b) => b[1] - a[1]))
    log(`     ${String(n).padStart(4)}  ${t.slice(0, 160)}`);
  log(`  elements whose row EXISTS but lacks the line's family token: ${wrongFamily.size} distinct`);
  for (const [k, n] of [...wrongFamily.entries()].sort((a, b) => b[1] - a[1]))
    log(`     ${String(n).padStart(4)}  ${k}`);
  notice(
    `Q2: orphan element texts ${orphans.size} distinct; wrong-family codes ${wrongFamily.size} distinct; ` +
    `special_addons rows with an empty categories array ${emptyCats.length}; with a lower-case family token ${caseOffenders.length}.`,
  );

  /* Would a code moved into variants.specials render as a NORMAL ticked row, or
     as a "retired - untick to remove" row? SoLineCard.specialOptions restricts
     the pool to the Model's allowed_options.specials WHENEVER that array is
     non-empty, so a restrictive Model turns a legitimate pick into a retired
     one. Counted over the products these sofa lines actually reference. */
  log("");
  log("  Model option-pool restriction (decides NORMAL tick vs 'retired' row):");
  const codesUsed = new Set(soLines.concat(poLines).flatMap((r) =>
    (Array.isArray(r.custom_specials) ? r.custom_specials : [])
      .map((el) => live.get(K(elText(el)))).filter(Boolean)));
  const models = await pg`
    SELECT DISTINCT p.code AS product_code, m.allowed_options
      FROM scm.mfg_products p
      LEFT JOIN scm.product_models m ON m.id = p.model_id
     WHERE p.company_id = ${CO} AND upper(p.category::text) = 'SOFA'`;
  let restrictive = 0, permissive = 0, wouldRetire = 0;
  for (const m of models) {
    const pool = m.allowed_options?.specials;
    if (!Array.isArray(pool) || pool.length === 0) { permissive++; continue; }
    restrictive++;
    const allowed = new Set(pool);
    if ([...codesUsed].some((c) => !allowed.has(c))) wouldRetire++;
  }
  log(`     SOFA products: ${models.length} — ${permissive} with an OPEN specials pool (any code ticks normally),`);
  log(`     ${restrictive} with a RESTRICTED pool, of which ${wouldRetire} would show at least one backfilled code as "retired".`);
  log(`     distinct picker codes the backfill actually landed: ${codesUsed.size}`);

  log("");
  notice(`Q3: lines carrying custom_specials — SO ${so.withSpecials} (dry-run promised 375), PO ${po.withSpecials} (promised 103).`);
  notice(`Q3: elements matching a live picker code ${so.codeEls + po.codeEls} (dry-run promised 498 matched); free text ${so.freeEls + po.freeEls} (promised 164).`);
  notice(`Q1: lines whose variants.specials is non-empty — SO ${so.withVariantSpecials}, PO ${po.withVariantSpecials}. This is what the picker renders as ticked.`);

  // ==========================================================================
  // Q1 — three real lines, both fields side by side
  // ==========================================================================
  const dump = (r) => {
    const vs = specialsList(r.variants?.specials ?? r.variants?.special);
    log("");
    log(`  ${r.doc_no}  line id ${r.id}  item ${r.code}`);
    log(`    description2      : ${String(r.d2 ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
    log(`    custom_specials   : ${JSON.stringify(r.custom_specials)}`);
    log(`    variants.specials : ${JSON.stringify(r.variants?.specials ?? r.variants?.special ?? null)}`);
    log(`    extraAddonNote    : ${JSON.stringify(r.variants?.extraAddonNote ?? null)}`);
    log(`    -> the picker header would read "Special Orders (${vs.length + (String(r.variants?.extraAddonNote ?? "").trim() ? 1 : 0)} selected)"`);
    log(`       of which ticked picker codes: ${vs.filter((c) => live.has(K(c))).length}`);
  };

  log("");
  log("=========== Q1  real SO lines that still carry custom_specials ===========");
  const withCs = soLines.filter((r) => Array.isArray(r.custom_specials) && r.custom_specials.length > 0).slice(0, 3);
  if (withCs.length === 0) log("  NONE — no migrated sofa SO line carries any custom_specials right now.");
  withCs.forEach(dump);

  /* The backfill's own population: a line whose description2 still decodes to a
     special order. These are the lines it reported writing, so they are the
     honest sample for "did the write land and does the picker show it". */
  log("");
  log("=========== Q1  real SO lines the backfill TARGETED (d2 carries a special) ===========");
  const targeted = soLines
    .filter((r) => /nilon|nylon|umbrella|fully cover|back ?rest|back ?cushion|firmer|wooden|bracket|notch|stitch/i.test(String(r.d2 ?? "")))
    .slice(0, 3);
  if (targeted.length === 0) log("  (no line matched the sample probe)");
  targeted.forEach(dump);

  log("");
  await pg.end();
  process.exit(0);
} catch (e) {
  console.error("check failed:", e.message);
  try { await pg.end(); } catch { /* ignore */ }
  process.exit(1);
}
