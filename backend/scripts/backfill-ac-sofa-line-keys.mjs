#!/usr/bin/env node
// Give the MIGRATED SOFA lines their AutoCount DtlKey — the one thing standing
// between an operator and editing an existing sofa order.
//
// WHY THE ORDINARY BACKFILL COULD NOT DO IT. backfill-ac-line-keys.mjs matches
// on (AutoCount DocNo + ERP item code), translating AutoCount's ItemCode
// through autocount-erp-mapping-1561.csv. For a sofa that translation lands on
// `9028-1S` — but the cutover SPLIT each sofa into compartment rows, so what
// the ERP actually holds is `9028-1A(LHF)`, `9028-2A(RHF)` and friends. The
// pair never matches, so every migrated sofa line kept a NULL key. That is the
// whole of the "589 PO lines with no AutoCount match" in the migration record,
// and it is why `/edit` refuses a sofa order today: composeEdit reads the key
// off the COLLAPSED line and a build with no key cannot be addressed.
//
// WHAT THIS DOES INSTEAD. It reproduces the D9 collapse the write-back itself
// uses: group the ERP compartment rows of one document into BUILDS by model,
// resolve the build to the `<model>-1S` code the mapping knows, and match THAT
// against AutoCount's lines. Every compartment row of a build then gets the
// SAME DtlKey — which is exactly what composeEdit requires, since it treats a
// build whose compartments disagree on the key as having no identity at all.
//
// WHAT IT REFUSES TO DO. If a document holds a different number of builds than
// AutoCount holds lines for that code, it assigns NOTHING for that group and
// reports it. A wrong DtlKey is worse than a missing one: a missing key is
// refused loudly by composeEdit, a wrong one silently edits a DIFFERENT line in
// a live account book. Ordering within a matched group follows the same
// assumption the ordinary backfill documents — the import inserted rows in
// DtlKey order, so line_no order and DtlKey order agree.
//
// DRY-RUN by default; APPLY=1 writes. Read the dry-run's per-group numbers
// before applying: this writes line identity, and line identity is what the
// edit path trusts.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

/* The model a compartment code belongs to: everything before the LAST hyphen.
   `9028-1A(LHF)` -> `9028`, `DSL-8030-1A(LHF)` -> `DSL-8030`. A code with no
   hyphen is not a compartment and is left to the ordinary backfill. */
function modelOf(code) {
  const c = (code || "").trim();
  const i = c.lastIndexOf("-");
  return i <= 0 ? null : c.slice(0, i);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  /* ERP code -> the AutoCount ItemCode(s) it came from. A sofa model routinely
     has several (one per supplier), which is why the match is on the ERP side. */
  const acByErp = new Map();
  for (const ln of csv) {
    const f = parseCsvLine(ln);
    const ac = norm(f[0]); const erp = norm(f[1]);
    if (!ac || !erp) continue;
    if (!acByErp.has(erp)) acByErp.set(erp, new Set());
    acByErp.get(erp).add(ac);
  }

  const acLines = (rows) => {
    // (DocNo | AutoCount ItemCode) -> DtlKeys, ascending
    const m = new Map();
    for (const r of rows) {
      const k = `${r.DocNo}|${norm(r.ItemCode)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(Number(r.DtlKey));
    }
    for (const v of m.values()) v.sort((a, b) => a - b);
    return m;
  };
  const soAc = acLines(gz("ac-outstanding-so.json.gz"));
  const poAc = acLines(gz("ac-outstanding-po.json.gz"));

  const run = async (label, rows, ac, table) => {
    /* Group the document's compartment rows into builds. */
    const builds = new Map(); // `${acDocNo}|${model}` -> { acDocNo, model, ids[], minLine }
    for (const r of rows) {
      const model = modelOf(r.code);
      if (!model) continue;
      const k = `${r.ac}|${norm(model)}`;
      if (!builds.has(k)) builds.set(k, { acDocNo: r.ac, model, ids: [], minLine: Number.POSITIVE_INFINITY });
      const b = builds.get(k);
      b.ids.push(r.id);
      const ln = r.line_no == null ? 0 : Number(r.line_no);
      if (ln < b.minLine) b.minLine = ln;
    }

    /* Builds of the same document + model that AutoCount holds as N lines. */
    const byDocModel = new Map();
    for (const b of builds.values()) {
      const k = `${b.acDocNo}|${norm(b.model)}`;
      if (!byDocModel.has(k)) byDocModel.set(k, []);
      byDocModel.get(k).push(b);
    }

    const updates = [];
    let noAcCode = 0, noAcLine = 0, countMismatch = 0, groups = 0;
    for (const [, group] of byDocModel) {
      groups++;
      const b0 = group[0];
      const erpCode = norm(`${b0.model}-1S`);
      const acCodes = acByErp.get(erpCode);
      if (!acCodes) { noAcCode++; continue; }

      /* Every AutoCount line on that document for any of the supplier-specific
         codes this ERP model maps to. */
      let keys = [];
      for (const acCode of acCodes) keys = keys.concat(ac.get(`${b0.acDocNo}|${acCode}`) ?? []);
      keys.sort((a, b) => a - b);
      if (!keys.length) { noAcLine++; continue; }

      if (keys.length !== group.length) {
        countMismatch++;
        log(`  SKIP ${b0.acDocNo} ${b0.model}: ${group.length} build(s) here, ${keys.length} AutoCount line(s) — not guessing which is which`);
        continue;
      }
      group.sort((x, y) => x.minLine - y.minLine);
      group.forEach((b, i) => { for (const id of b.ids) updates.push({ id, key: keys[i] }); });
    }

    log(`${label}: sofa builds ${builds.size} in ${groups} document/model group(s); rows to key ${updates.length}; no mapping ${noAcCode}; no AutoCount line ${noAcLine}; count mismatch ${countMismatch}`);
    if (!APPLY || !updates.length) return;
    for (let i = 0; i < updates.length; i += 200) {
      const b = updates.slice(i, i + 200);
      await sql.begin(async (tx) => {
        for (const u of b) await tx.unsafe(`UPDATE scm.${table} SET linked_ac_dtlkey = $1 WHERE id = $2`, [u.key, u.id]);
      });
      log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
    }
  };

  /* Only rows that still have NO key, and only on documents AutoCount holds. */
  const soRows = await sql`SELECT i.id, i.item_code AS code, i.line_no, h.linked_ac_docno AS ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND i.linked_ac_dtlkey IS NULL AND i.item_group ILIKE 'sofa'`;
  await run("SO sofa lines", soRows, soAc, "mfg_sales_order_items");

  const poRows = await sql`SELECT i.id, i.item_code AS code, NULL::int AS line_no, h.linked_ac_docno AS ac
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND i.linked_ac_dtlkey IS NULL AND i.item_group ILIKE 'sofa'`;
  await run("PO sofa lines", poRows, poAc, "purchase_order_items");

  if (!APPLY) log("DRY-RUN — read the per-group numbers above, then set APPLY=1 to write.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
