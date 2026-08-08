#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fix-hc-sofa-branding.mjs — HC (Houzs) sofa branding is Zanotti, not "Houzs".
//
// Owner rule (2026-08-08, verbatim): "houzs 的 sofa brand 是 zanotti; 2990 的
// sofa brand 是 2990 sofa". The Houzs company's SOFA SKUs were seeded with
// branding='Houzs' (reseed-sofa-models.mjs seeded the models that way, and
// generate-skus copied it onto every SKU), so every HC sofa SO line displays
// BRANDING "Houzs" (e.g. HC-SO-2607-013, model 8030 lines) instead of
// "Zanotti". 2990's side is correct ("2990s Sofa"). The brand-logo print path
// is NOT affected — mfg-sales-orders.ts resolves the SO PDF letterhead from
// project_brands by NAME (name.toUpperCase() === 'ZANOTTI'), not from the
// branding text — but the list/detail Branding pill and every stamped line
// snapshot read the text this script fixes.
//
// DRY-RUN reports, for the HOUZS company only (company_id resolved from
// public.companies by code, printed, never hardcoded):
//   (a) every SOFA-category scm.mfg_products row (and scm.product_models —
//       models mint SKUs via generate-skus, so a 'Houzs' model would re-seed
//       the bug) whose branding is not the expected value, current -> target;
//   (b) every line row for those SKU codes whose stamped branding is 'Houzs'
//       or blank, with its doc number and doc status. Line tables that carry
//       a branding column: scm.mfg_sales_order_items and
//       scm.consignment_sales_order_items. scm.delivery_order_items and
//       scm.consignment_delivery_order_items have NO branding column (DO
//       surfaces derive display branding from the SO's lines) — verified
//       against information_schema at run time and reported, so schema drift
//       shows up here instead of being silently skipped;
//   (c) every SERVICE-category HOUZS catalog row whose branding is BLANK —
//       owner addendum 2026-08-08: "service 的 branding 就放 service" — blank
//       fills to 'Service'; a non-blank service branding is reported and left
//       alone. Catalog only (no line re-stamp: derive-line-branding fills
//       future blank lines from the catalog, and the owner's ruling was about
//       the registry);
//   (d) every BEDFRAME-category HOUZS catalog row whose branding is BLANK —
//       owner addendum #2 2026-08-08: "有 mattress brand 就放 mattress brand
//       没有就放 bedframe". A bedframe that evidently belongs to a mattress
//       brand family takes THAT brand; otherwise 'Bedframe'. Evidence is
//       CONSERVATIVE and derived from live data, never a hardcoded list: the
//       brand vocabulary is the HC MATTRESS rows' own distinct brandings
//       (printed), a match is the brand name as a whole word in the row's
//       name/code OR a code prefix (e.g. 'AK-') that is unique to exactly one
//       brand's own mattress SKUs. Rows matching TWO different brands are
//       REFUSED (left blank, reported) — conflicting evidence is not clear
//       evidence. The DRY-RUN lists EVERY blank bedframe row with its
//       decision + the exact evidence string so the owner can veto before
//       APPLY;
//   (e) MATTRESS blank-branding rows for HOUZS — REPORT ONLY (the owner has
//       not ruled): each blank row is listed with the brand the same
//       name-evidence method WOULD suggest, so the owner can rule next;
//       never written;
//   (f) a REPORT-ONLY sanity section on the 2990 company (expected
//       '2990 Sofa' family — actual values are printed; 2990 is NEVER
//       modified by this script — owner: "确保是 houzs century 的故事而已");
//   (g) whether an active 'Zanotti' row exists in project_brands (the print
//       logo lookup matches name.toUpperCase() === 'ZANOTTI') and whether it
//       carries a logo_r2_key. If absent, the owner must add the brand +
//       upload the logo in Project Maintenance -> Brands — this script never
//       creates brand rows.
//
// WHY BOTH scm.mfg_products AND scm.product_models: display reads
// mfg_products.branding — deriveLineBrandingFromProduct (write-time line
// fill) and the SO list's catalog fallback both select from mfg_products.
// product_models is what POST /product-models/:id/generate-skus copies
// branding FROM when minting SKUs, so a 'Houzs'/blank model would quietly
// re-seed the bug on the next regeneration. Both are fixed, same rules.
//
// Target casing: canonical-first (same rule as backfill-branding-to-canonical
// — the dropdown owns the spelling). The exact string written is the HOUZS
// company's ACTIVE project_brands name matching 'zanotti' case-insensitively;
// when the dropdown has no such row we fall back to the literal 'Zanotti'
// (title case, the catalog's own style — 'Houzs', 'Akemi', '2990s Sofa') and
// say so. The SO list badge uppercases for display either way
// (MfgSalesOrdersListV2.tsx), so casing here is about catalog hygiene.
//
// APPLY re-stamps ONLY rows whose current branding is 'Houzs'
// (case-insensitive) or blank. A deliberately different manual value (a third
// brand someone typed on purpose) is LEFT ALONE and reported — same posture
// as backfill-branding-to-canonical's no-match rule. Everything runs in ONE
// transaction; every UPDATE's row count must equal the count the same
// transaction just detected, and a post-verify must find zero remaining
// 'Houzs'/blank rows in the target sets — any mismatch rolls the whole thing
// back. DRY-RUN performs the identical transaction and always rolls back
// (repair-so-fee-line-integrity.mjs posture).
//
//   node backend/scripts/fix-hc-sofa-branding.mjs                    # DRY-RUN
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/fix-hc-sofa-branding.mjs
//
// No mfg_so_audit_log rows are written: this is a display-truth backfill of a
// snapshot column across many docs, not a document mutation — flooding every
// affected SO's timeline would bury real events (the fee repair writes audit
// rows because it materialises a LINE; this changes no quantity or money).
// ---------------------------------------------------------------------------

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

const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = process.env.APPLY === "true" && process.env.CONFIRM === CONFIRM_PHRASE;
if (process.env.APPLY === "true" && !APPLY) {
  console.log(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}" — running DRY-RUN instead.\n`);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const show = (v) => (v == null ? "NULL" : `"${v}"`);

/** Thrown to force a rollback after a successful dry-run. Not an error. */
class DryRunRollback extends Error {}

/** Line tables that SHOULD carry branding vs the ones that don't — verified
 *  against information_schema so prod drift is reported, never assumed. */
const LINE_TABLES = [
  { table: "mfg_sales_order_items", docTable: "mfg_sales_orders", docCol: "doc_no", expectBranding: true },
  { table: "consignment_sales_order_items", docTable: "consignment_sales_orders", docCol: "doc_no", expectBranding: true },
  { table: "delivery_order_items", expectBranding: false },
  { table: "consignment_delivery_order_items", expectBranding: false },
];

try {
  console.log(`\nHC SOFA BRANDING FIX — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing will be written)"}\n`);

  await pg.begin(async (sql) => {
    const fail = (why) => {
      throw new Error(`VERIFY FAILED — ${why} — rolling back, nothing was changed.`);
    };

    /* Companies — resolved, never hardcoded. */
    const cos = await sql`SELECT id, code, name FROM public.companies WHERE code IN ('HOUZS', '2990') ORDER BY code`;
    const houzs = cos.find((c) => c.code === "HOUZS");
    const c2990 = cos.find((c) => c.code === "2990");
    if (!houzs) fail("no public.companies row with code 'HOUZS'");
    const hcId = Number(houzs.id);
    console.log(`Resolved companies: HOUZS -> id=${hcId} (${houzs.name})${c2990 ? `; 2990 -> id=${Number(c2990.id)} (${c2990.name})` : "; 2990 -> NOT FOUND"}\n`);

    /* (g) Zanotti in project_brands — report only. The SO PDF letterhead
       lookup (mfg-sales-orders.ts) reads ALL active brands and matches
       name.toUpperCase() === 'ZANOTTI', so the row + logo must exist for the
       logo to print. We NEVER create one here. */
    const brandRows = await sql`
      SELECT id, company_id, name, active, logo_r2_key
        FROM public.project_brands
       WHERE upper(btrim(name)) = 'ZANOTTI'
       ORDER BY company_id, id`;
    console.log("=== project_brands 'Zanotti' (print-logo lookup is by NAME) ===");
    if (brandRows.length === 0) {
      console.log("  NO 'Zanotti' brand row exists in project_brands (any company).");
      console.log("  The SO PDF can NOT print the Zanotti letterhead until the owner adds the");
      console.log("  brand AND uploads its logo in Project Maintenance -> Brands. Not created here.");
    } else {
      for (const b of brandRows) {
        const logo = b.logo_r2_key && String(b.logo_r2_key).trim() !== "" ? `logo_r2_key=${b.logo_r2_key}` : "NO LOGO — upload one in Project Maintenance -> Brands or the PDF keeps the company letterhead";
        console.log(`  id=${b.id}  company_id=${b.company_id}  name=${show(b.name)}  active=${b.active}  ${logo}`);
      }
    }

    /* Target casing — canonical-first from HOUZS's own ACTIVE dropdown row. */
    const hcZanotti = brandRows.find((b) => Number(b.company_id) === hcId && Number(b.active) === 1);
    const TARGET = hcZanotti ? String(hcZanotti.name).trim() : "Zanotti";
    console.log(`\nTarget branding value: ${show(TARGET)} ${hcZanotti ? "(exact casing of HOUZS's active project_brands row)" : "(literal fallback — HOUZS has no active 'Zanotti' dropdown row yet; owner should add it)"}\n`);

    /* (a) Catalog — SOFA rows off the expected value. mfg_products is what
       derive-line-branding.ts and the list's catalog fallback read;
       product_models is what generate-skus copies branding FROM. */
    let expectedCatalogRestamps = 0;
    for (const t of ["mfg_products", "product_models"]) {
      const rows = await sql`
        SELECT id, ${sql(t === "mfg_products" ? "code" : "model_code")} AS code, branding
          FROM ${sql("scm." + t)}
         WHERE company_id = ${hcId}
           AND category = 'SOFA'
           AND (branding IS NULL OR btrim(branding) <> ${TARGET})
         ORDER BY 2`;
      console.log(`=== (a) HOUZS SOFA ${t} rows whose branding != ${show(TARGET)} — ${rows.length} row(s) ===`);
      let restamp = 0;
      for (const r of rows) {
        const cur = r.branding == null || String(r.branding).trim() === "" ? null : String(r.branding).trim();
        const touchable = cur == null || cur.toLowerCase() === "houzs";
        if (touchable) restamp++;
        console.log(`  ${r.code}: ${show(r.branding)} -> ${touchable ? show(TARGET) : `LEFT ALONE (manual value, not 'Houzs'/blank) — needs an owner decision`}`);
      }
      console.log(`  will re-stamp ${restamp}, leave ${rows.length - restamp}\n`);
      expectedCatalogRestamps += restamp;

      if (restamp > 0) {
        const res = await sql`
          UPDATE ${sql("scm." + t)}
             SET branding = ${TARGET}
           WHERE company_id = ${hcId}
             AND category = 'SOFA'
             AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs')`;
        if (res.count !== restamp) fail(`${t}: updated ${res.count} rows, detected ${restamp}`);
      }
    }

    /* The affected SKU codes = every HOUZS SOFA catalog code (post-update the
       catalog rows already read TARGET; the code set is branding-independent). */
    const codeRows = await sql`
      SELECT code FROM scm.mfg_products WHERE company_id = ${hcId} AND category = 'SOFA'`;
    /* postgres.js cannot type an EMPTY array parameter — the [""] fallback
       matches no real item_code and keeps every ANY(...) below well-typed. */
    const codes = codeRows.length ? codeRows.map((r) => r.code) : [""];
    console.log(`HOUZS SOFA SKU codes in catalog: ${codeRows.length}\n`);

    /* (b) Stamped line rows for those codes. */
    for (const lt of LINE_TABLES) {
      const [col] = await sql`
        SELECT 1 AS present FROM information_schema.columns
         WHERE table_schema = 'scm' AND table_name = ${lt.table} AND column_name = 'branding'`;
      if (!lt.expectBranding) {
        console.log(`=== (b) scm.${lt.table} — ${col ? "UNEXPECTED: a branding column EXISTS (schema drifted since this script was written) — NOT scanned; extend the script before trusting this table" : "no branding column (as expected — DO surfaces derive display branding from the SO's lines); nothing to re-stamp"} ===\n`);
        continue;
      }
      if (!col) fail(`scm.${lt.table} has no branding column — schema does not match this script`);
      if (codeRows.length === 0) {
        console.log(`=== (b) scm.${lt.table} — no HOUZS SOFA codes in catalog, nothing to scan ===\n`);
        continue;
      }

      const rows = await sql`
        SELECT i.id, i.doc_no, i.item_code, i.branding, i.cancelled, d.status AS doc_status
          FROM ${sql("scm." + lt.table)} i
          LEFT JOIN ${sql("scm." + lt.docTable)} d ON d.${sql(lt.docCol)} = i.doc_no
         WHERE i.company_id = ${hcId}
           AND i.item_code = ANY(${codes})
           AND (i.branding IS NULL OR btrim(i.branding) = '' OR lower(btrim(i.branding)) = 'houzs')
         ORDER BY i.doc_no, i.item_code`;
      console.log(`=== (b) scm.${lt.table} rows stamped 'Houzs'/blank for those codes — ${rows.length} row(s) ===`);
      for (const r of rows) {
        console.log(`  ${r.doc_no} [${r.doc_status ?? "NO HEADER"}]${r.cancelled ? " (line cancelled)" : ""}  ${r.item_code}: ${show(r.branding)} -> ${show(TARGET)}`);
      }
      /* Off-family manual values are reported (left alone) so nothing hides. */
      const manual = await sql`
        SELECT i.doc_no, i.item_code, i.branding, d.status AS doc_status
          FROM ${sql("scm." + lt.table)} i
          LEFT JOIN ${sql("scm." + lt.docTable)} d ON d.${sql(lt.docCol)} = i.doc_no
         WHERE i.company_id = ${hcId}
           AND i.item_code = ANY(${codes})
           AND i.branding IS NOT NULL AND btrim(i.branding) <> ''
           AND lower(btrim(i.branding)) NOT IN ('houzs', ${TARGET.toLowerCase()})
         ORDER BY i.doc_no, i.item_code`;
      for (const r of manual) {
        console.log(`  ${r.doc_no} [${r.doc_status ?? "NO HEADER"}]  ${r.item_code}: ${show(r.branding)} — LEFT ALONE (manual value, not 'Houzs'/blank)`);
      }
      console.log(`  will re-stamp ${rows.length}, leave ${manual.length} manual\n`);

      if (rows.length > 0) {
        const res = await sql`
          UPDATE ${sql("scm." + lt.table)}
             SET branding = ${TARGET}
           WHERE company_id = ${hcId}
             AND item_code = ANY(${codes})
             AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs')`;
        if (res.count !== rows.length) fail(`${lt.table}: updated ${res.count} rows, detected ${rows.length}`);
      }
    }

    /* (c) SERVICE — owner addendum 2026-08-08: blank service branding fills
       to 'Service' (canonical dropdown casing when HOUZS maintains one).
       Catalog only; non-blank service values are reported, never touched. */
    const [svcBrand] = await sql`
      SELECT btrim(name) AS name FROM public.project_brands
       WHERE company_id = ${hcId} AND active = 1 AND lower(btrim(name)) = 'service'
       LIMIT 1`;
    const TARGET_SERVICE = svcBrand ? svcBrand.name : "Service";
    console.log(`=== (c) HOUZS SERVICE catalog rows — blank fills to ${show(TARGET_SERVICE)} ${svcBrand ? "(dropdown casing)" : "(literal — no active 'Service' dropdown row)"} ===`);
    for (const t of ["mfg_products", "product_models"]) {
      const codeCol = t === "mfg_products" ? "code" : "model_code";
      const blanks = await sql`
        SELECT ${sql(codeCol)} AS code FROM ${sql("scm." + t)}
         WHERE company_id = ${hcId} AND category = 'SERVICE'
           AND (branding IS NULL OR btrim(branding) = '')
         ORDER BY 1`;
      const nonBlank = await sql`
        SELECT COALESCE(NULLIF(btrim(branding), ''), '(blank)') AS branding, count(*)::int AS n
          FROM ${sql("scm." + t)}
         WHERE company_id = ${hcId} AND category = 'SERVICE'
           AND branding IS NOT NULL AND btrim(branding) <> ''
         GROUP BY 1 ORDER BY 2 DESC`;
      console.log(`  scm.${t}: ${blanks.length} blank row(s) -> ${show(TARGET_SERVICE)}${blanks.length ? ": " + blanks.map((r) => r.code).join(", ") : ""}`);
      for (const r of nonBlank) console.log(`  scm.${t}: ${show(r.branding)} on ${r.n} row(s) — LEFT ALONE (non-blank)`);
      if (blanks.length > 0) {
        const res = await sql`
          UPDATE ${sql("scm." + t)}
             SET branding = ${TARGET_SERVICE}
           WHERE company_id = ${hcId} AND category = 'SERVICE'
             AND (branding IS NULL OR btrim(branding) = '')`;
        if (res.count !== blanks.length) fail(`${t} SERVICE: updated ${res.count} rows, detected ${blanks.length}`);
      }
    }
    console.log("");

    /* (d) BEDFRAME — owner addendum #2 2026-08-08: "有 mattress brand 就放
       mattress brand 没有就放 bedframe". Brand vocabulary + code prefixes are
       DERIVED FROM LIVE DATA (HC's own MATTRESS rows), never hardcoded. */
    const vocabRows = await sql`
      SELECT DISTINCT btrim(branding) AS b FROM scm.mfg_products
       WHERE company_id = ${hcId} AND category = 'MATTRESS' AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION
      SELECT DISTINCT btrim(branding) FROM scm.product_models
       WHERE company_id = ${hcId} AND category = 'MATTRESS' AND branding IS NOT NULL AND btrim(branding) <> ''`;
    /* 'houzs' is the company, not brand evidence; generic category words are
       not brands. Both excluded so a name like "HOUZS BEDFRAME" or a branding
       literally reading "Mattress" can never masquerade as a family. */
    const VOCAB_EXCLUDE = new Set(["houzs", "mattress", "bedframe", "accessories", "service"]);
    const vocab = vocabRows.map((r) => r.b).filter((b) => !VOCAB_EXCLUDE.has(b.toLowerCase()));
    console.log(`=== (d) HOUZS BEDFRAME catalog rows — blank rows take a mattress-family brand on clear evidence, else 'Bedframe' ===`);
    console.log(`  mattress-brand vocabulary (derived from HC MATTRESS rows' own brandings): ${vocab.length ? vocab.map(show).join(", ") : "(EMPTY — every blank bedframe will fall to 'Bedframe')"}`);

    /* Code prefixes unique to ONE brand's own mattress SKUs (e.g. 'AK-' ->
       Akemi). A prefix shared by two brands is not evidence. */
    const prefixRows = await sql`
      SELECT DISTINCT upper(split_part(code, '-', 1)) AS pfx, btrim(branding) AS b
        FROM scm.mfg_products
       WHERE company_id = ${hcId} AND category = 'MATTRESS'
         AND branding IS NOT NULL AND btrim(branding) <> ''
         AND position('-' IN code) > 1`;
    const pfxMap = new Map(); // PFX -> Set(brand)
    for (const r of prefixRows) {
      if (r.pfx.length < 2 || VOCAB_EXCLUDE.has(r.b.toLowerCase())) continue;
      if (!pfxMap.has(r.pfx)) pfxMap.set(r.pfx, new Set());
      pfxMap.get(r.pfx).add(r.b);
    }
    const uniquePfx = [...pfxMap.entries()].filter(([, s]) => s.size === 1).map(([p, s]) => [p, [...s][0]]);
    console.log(`  unique code prefixes (each used by exactly one brand's mattress SKUs): ${uniquePfx.length ? uniquePfx.map(([p, b]) => `${p}- -> ${show(b)}`).join(", ") : "(none)"}`);

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = (brand) => new RegExp(`(^|[^A-Z0-9])${esc(brand.toUpperCase())}([^A-Z0-9]|$)`);
    /** Returns { brand, evidence } | { conflict: [brands] } | null. */
    const brandEvidence = (code, name) => {
      const C = String(code ?? "").toUpperCase();
      const N = String(name ?? "").toUpperCase();
      const hits = new Map(); // brand -> evidence
      for (const b of vocab) {
        if (wordRe(b).test(N)) hits.set(b, `name contains "${b.toUpperCase()}"`);
        else if (wordRe(b).test(C)) hits.set(b, `code contains "${b.toUpperCase()}"`);
      }
      for (const [pfx, b] of uniquePfx) {
        if (C.startsWith(pfx + "-") && !hits.has(b)) hits.set(b, `code prefix "${pfx}-" (unique to ${b} mattress SKUs)`);
      }
      if (hits.size === 1) { const [[brand, evidence]] = hits.entries(); return { brand, evidence }; }
      if (hits.size > 1) return { conflict: [...hits.entries()].map(([b, e]) => `${b} (${e})`) };
      return null;
    };

    const [bfBrand] = await sql`
      SELECT btrim(name) AS name FROM public.project_brands
       WHERE company_id = ${hcId} AND active = 1 AND lower(btrim(name)) = 'bedframe'
       LIMIT 1`;
    const TARGET_BEDFRAME = bfBrand ? bfBrand.name : "Bedframe";
    let bedframeConflicts = 0;
    for (const t of ["mfg_products", "product_models"]) {
      const codeCol = t === "mfg_products" ? "code" : "model_code";
      const rows = await sql`
        SELECT id, ${sql(codeCol)} AS code, name FROM ${sql("scm." + t)}
         WHERE company_id = ${hcId} AND category = 'BEDFRAME'
           AND (branding IS NULL OR btrim(branding) = '')
         ORDER BY 2`;
      console.log(`  -- scm.${t}: ${rows.length} blank BEDFRAME row(s) --`);
      const byTarget = new Map(); // target branding -> ids
      for (const r of rows) {
        const ev = brandEvidence(r.code, r.name);
        if (ev && ev.conflict) {
          bedframeConflicts++;
          console.log(`  ${r.code} (${r.name}): REFUSED — conflicting evidence [${ev.conflict.join("; ")}] — left blank, owner decides`);
          continue;
        }
        const target = ev ? ev.brand : TARGET_BEDFRAME;
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(String(r.id));
        console.log(`  ${r.code} (${r.name}): -> ${show(target)} — ${ev ? ev.evidence : `no brand evidence -> ${show(TARGET_BEDFRAME)}`}`);
      }
      for (const [target, ids] of byTarget) {
        const res = await sql`
          UPDATE ${sql("scm." + t)}
             SET branding = ${target}
           WHERE id::text = ANY(${ids})
             AND (branding IS NULL OR btrim(branding) = '')`;
        if (res.count !== ids.length) fail(`${t} BEDFRAME -> ${target}: updated ${res.count} rows, expected ${ids.length}`);
      }
    }
    console.log("");

    /* (e) MATTRESS — REPORT ONLY (owner has not ruled). Suggestions use the
       SAME evidence method so the owner can rule on them next. NEVER written. */
    console.log("=== (e) HOUZS MATTRESS blank-branding rows — REPORT ONLY, suggestions for the owner, NOT written ===");
    for (const t of ["mfg_products", "product_models"]) {
      const codeCol = t === "mfg_products" ? "code" : "model_code";
      const rows = await sql`
        SELECT ${sql(codeCol)} AS code, name FROM ${sql("scm." + t)}
         WHERE company_id = ${hcId} AND category = 'MATTRESS'
           AND (branding IS NULL OR btrim(branding) = '')
         ORDER BY 1`;
      console.log(`  -- scm.${t}: ${rows.length} blank MATTRESS row(s) --`);
      for (const r of rows) {
        const ev = brandEvidence(r.code, r.name);
        if (ev && ev.conflict) console.log(`  ${r.code} (${r.name}): conflicting evidence [${ev.conflict.join("; ")}] — owner to rule`);
        else if (ev) console.log(`  ${r.code} (${r.name}): would suggest ${show(ev.brand)} — ${ev.evidence}`);
        else console.log(`  ${r.code} (${r.name}): no brand evidence — owner to rule`);
      }
    }
    console.log("");

    /* Post-verify: the write-target sets are clean. Catalog rows LEFT ALONE
       are non-blank non-'Houzs' by definition, so zero remaining dirty rows
       proves exactly the re-stamp — no more, no less. BEDFRAME's only allowed
       leftovers are the REFUSED conflicts. */
    const [dirty] = await sql`
      SELECT (SELECT count(*) FROM scm.mfg_products
               WHERE company_id = ${hcId} AND category = 'SOFA'
                 AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs'))
           + (SELECT count(*) FROM scm.product_models
               WHERE company_id = ${hcId} AND category = 'SOFA'
                 AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs'))
           + (SELECT count(*) FROM scm.mfg_products
               WHERE company_id = ${hcId} AND category = 'SERVICE'
                 AND (branding IS NULL OR btrim(branding) = ''))
           + (SELECT count(*) FROM scm.product_models
               WHERE company_id = ${hcId} AND category = 'SERVICE'
                 AND (branding IS NULL OR btrim(branding) = ''))
           + (SELECT count(*) FROM scm.mfg_sales_order_items
               WHERE company_id = ${hcId} AND item_code = ANY(${codes})
                 AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs'))
           + (SELECT count(*) FROM scm.consignment_sales_order_items
               WHERE company_id = ${hcId} AND item_code = ANY(${codes})
                 AND (branding IS NULL OR btrim(branding) = '' OR lower(btrim(branding)) = 'houzs'))
             AS n`;
    if (Number(dirty.n) !== 0) fail(`post-verify found ${dirty.n} remaining dirty row(s) in the SOFA/SERVICE/line target sets`);
    const [bfLeft] = await sql`
      SELECT (SELECT count(*) FROM scm.mfg_products
               WHERE company_id = ${hcId} AND category = 'BEDFRAME' AND (branding IS NULL OR btrim(branding) = ''))
           + (SELECT count(*) FROM scm.product_models
               WHERE company_id = ${hcId} AND category = 'BEDFRAME' AND (branding IS NULL OR btrim(branding) = ''))
             AS n`;
    if (Number(bfLeft.n) !== bedframeConflicts) fail(`post-verify: ${bfLeft.n} blank BEDFRAME row(s) remain but only ${bedframeConflicts} were refused as conflicts`);
    console.log(`Post-verify OK: target sets clean (SOFA catalog re-stamps: ${expectedCatalogRestamps}; bedframe conflicts left for the owner: ${bedframeConflicts}).\n`);

    /* (f) 2990 sanity — REPORT ONLY, never modified here ("确保是 houzs
       century 的故事而已"). Owner rule expects the '2990 Sofa' family; the
       actual stored family is printed as-is. */
    if (c2990) {
      const cid = Number(c2990.id);
      const cat = await sql`
        SELECT COALESCE(NULLIF(btrim(branding), ''), '(blank)') AS branding, count(*)::int AS n
          FROM scm.mfg_products
         WHERE company_id = ${cid} AND category = 'SOFA'
         GROUP BY 1 ORDER BY n DESC, 1`;
      console.log("=== (f) 2990 SOFA catalog branding (REPORT ONLY — expected the '2990 Sofa' family; NOT modified) ===");
      for (const r of cat) console.log(`  ${show(r.branding)}  on ${r.n} SKU(s)`);
      const lines = await sql`
        SELECT COALESCE(NULLIF(btrim(i.branding), ''), '(blank)') AS branding, count(*)::int AS n
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
         WHERE i.company_id = ${cid} AND p.category = 'SOFA'
         GROUP BY 1 ORDER BY n DESC, 1`;
      console.log("  -- SO line stamps on 2990 SOFA codes --");
      for (const r of lines) console.log(`  ${show(r.branding)}  on ${r.n} line(s)`);
      console.log("");
    } else {
      console.log("=== (f) 2990 sanity SKIPPED — no public.companies row with code '2990' ===\n");
    }

    if (!APPLY) throw new DryRunRollback("dry-run");
  });

  notice(APPLY ? "APPLIED — HOUZS sofa branding re-stamped and committed." : "DRY-RUN complete — verified in-transaction and rolled back; nothing was written.");
} catch (e) {
  if (e instanceof DryRunRollback) {
    notice("DRY-RUN complete — verified in-transaction and rolled back; nothing was written.");
  } else {
    console.error(`FIX_FAIL ${e.message}`);
    await pg.end({ timeout: 5 });
    process.exit(1);
  }
} finally {
  await pg.end({ timeout: 5 });
}
