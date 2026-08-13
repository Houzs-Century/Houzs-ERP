#!/usr/bin/env node
// RDS-5526 is its own sofa model. Open it, and take the nine cutover document
// lines off 8038.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// data/autocount-erp-mapping-1561.csv bound "RDS-5526 SOFA" to "8038-1S" with
// status EXISTS(1st-pass) — a fuzzy NAME match, not an owner decision. Both
// models are called DISCOVERY, but they are different suppliers' products:
// 8038 is DSL (400-D004), 5526 is RED SOFA PLT (400-R001). The row contradicts
// its own neighbour: "RDS-5526 CONSOLE" was mapped NEW/ACCESSORY rather than to
// 8038-Console, which exists. Owner 2026-08-10: "5526 就是 5526 啊,你应该要
// remain ... 8038 原本都不是 5526."
//
// The consequence of the bad row is that 5526 never got the model row every
// other AutoCount sofa code got (align-models-houzs-century.json seeded 69 of
// them, each name = model_code, compartments = ["1S"]), so its builds cannot be
// corrected: there is no 5526 SKU to point a line at.
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────────
//  1. creates scm.product_models 5526 (name "5526", the same convention its
//     sibling RED SOFA model 5527 and 8133 were seeded with — NOT "DISCOVERY",
//     which 8038 already owns and whose reuse is the bug being fixed)
//  2. opens the compartments below on 5526, and STOOL on 8133
//  3. mints {model}-{comp} in scm.mfg_products, named "SOFA {name} {comp}" with
//     no branding prefix (rename-minted-sofa-sku-names.mjs, owner 2026-08-09)
//  4. appends any code new to the master pool sofaCompartments (append-only)
//  5. re-points the nine AutoCount source lines from 8038-* to 5526-*, and
//     carries the change down SO -> PO -> GRN and SO -> DO
//
// Steps 1-4 are the three-part opening docs/sofa-import-handoff.md §3.2
// requires: skip the model's allowed_options and the line fails
// allowed-options-check in the UI; skip the pool and nobody can ever tick the
// code again.
//
// THE MONEY DOES NOT MOVE. Only material_code / item_code and the display name
// change. No price, qty or total column is written, and the per-document sofa
// total is printed before and after as evidence.
//
// NOT DONE HERE, ON PURPOSE — the supplier price list bound RED SOFA's 5526
// prices onto 8038 SKUs through the same bad row (8038-1A(LHF), 8038-1NA,
// 8038-2A(RHF), 8038-CNR, 8038-Console, 8038-STOOL all carry supplier_sku
// "RDS-5526 SOFA", and 8038-1S is its main binding). Re-pointing those moves
// prices, so it is the owner's call, not this script's.
//
// MODE=dry-run (default) runs the whole transaction and rolls it back;
// MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
// RE-RUN: convergent, but APPENDS a maintenance_config_history row on every run; the model, SKU and line re-codes all test the current state first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const K = (s) => String(s ?? "").trim().toUpperCase();
const modelOf = (c) => { const s = K(c); const d = s.indexOf("-"); return d < 0 ? s : s.slice(0, d); };
const compOf = (c) => { const s = K(c); const d = s.indexOf("-"); return d < 0 ? "" : s.slice(d + 1); };

const FROM_MODEL = "8038";
const MODEL = "5526";
const MODEL_NAME = "5526";
const BRANDING = "";

/* Every compartment below is what parse-sofa.mjs (the one true decoder) returns
   for one of the nine AutoCount Desc2 strings, at model 5526. The decode is
   identical with the recliner flag on or off, so nothing here depends on
   guessing whether 5526 has a recliner mechanism. */
const COMPARTMENTS = [
  { c: "1S",      why: "placeholder base for the two builds that do not decode (SO-000814 / PO-000254 \"(1 ELT / T + NA +2ER)\"), and the code the importers strip to read the model" },
  { c: "2S",      why: "SO-001526 dtl 102958 \"2S(28\\\")\"; PO-002425 \"2S+WOODEN ARM (28\\\")\"" },
  { c: "1A(LHF)", why: "SO-001526 dtl 102956 \"1EL(35\\\")\"" },
  { c: "1A(RHF)", why: "PO-001662 \"3S(35\\\") + C/T\" -> 2A(LHF)+Console+1A(RHF)" },
  { c: "2A(LHF)", why: "SO-001112, SO-001526 dtl 102957, PO-001662" },
  { c: "2A(RHF)", why: "SO-001112, SO-001526 dtl 102956" },
  { c: "Console", why: "SO-001112 and PO-001662 both write C/T" },
  { c: "STOOL",   why: "SO-001526 dtl 102957 \"STOOL(28\\\")\"" },
  { c: "DB",      why: "PO-000162 \"[DAYBED/COL:J9833-2]\" — the Daybed code the owner added to the pool 2026-08-10" },
];

/* 8133 (RED SOFA too) has nine compartments minted but never STOOL, so the
   owner-approved correction for HC-PO-000136 — Desc2 "(STOOL) / (L 38' x W
   30\") / Col: Harring 02# beige" — refuses with "piece SKU not minted:
   8133-STOOL". Model 8133 already exists; this only opens the one piece. */
const ALSO_OPEN = [{ model: "8133", comps: ["STOOL"] }];

/* The nine AutoCount source lines that carry an 8038 code only because of the
   mapping row. desc2 is the AutoCount text verbatim — the importers store it in
   description2, and a document can hold more than one build, so it is the only
   safe way to narrow. `remap` re-reads a compartment at the same time as the
   model; it is used once, for the daybed. */
const REPOINT = [
  { ac: "SO-000814", kind: "so", dtl: 58980, desc2: `[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`,
    expect: ["1S"], note: "stays a SOFA UNPARSED placeholder — \"1 ELT / T\" is not readable, and the rule is never guess a piece" },
  { ac: "SO-001112", kind: "so", dtl: 78318, desc2: `[ 2S(28") + 2.5(35") + C/T / COL: 7# CHARCOAL]`,
    expect: ["2A(LHF)", "Console", "2A(RHF)"] },
  { ac: "SO-001526", kind: "so", dtl: 102956, desc2: `[ 1EL(35") + 2ER(35") / COL: BEETEX HARRING GD8371 02# BEIGE ]`,
    expect: ["1A(LHF)", "2A(RHF)"] },
  { ac: "SO-001526", kind: "so", dtl: 102957, desc2: `[ 2EL(28") + STOOL(28")(NO BACK CUSHION) / COL: BEETEX HARRING GD8371 02# BEIGE`,
    expect: ["2A(LHF)", "STOOL"] },
  { ac: "SO-001526", kind: "so", dtl: 102958, desc2: `[ 2S(28") / COL: BEETEX HARRING GD8371 02# BEIGE`,
    expect: ["2S"] },
  { ac: "PO-000162", kind: "po", dtl: 52191, desc2: `[DAYBED/COL:J9833-2]`,
    expect: ["1S"], remap: { "1S": "DB" }, note: "the only line whose PIECE changes: the placeholder becomes the Daybed the Desc2 names" },
  { ac: "PO-001662", kind: "po", dtl: 218466, desc2: `COL: J9883-2-Chic  (PREMIUM) / 3S(35") + C/T`,
    expect: ["2A(LHF)", "Console", "1A(RHF)"] },
  { ac: "PO-002425", kind: "po", dtl: 294186, desc2: `2S+WOODEN ARM  (28") / COL-HARRING GD 8371 02-BEIGE`,
    expect: ["2S"] },
  { ac: "PO-000254", kind: "po", dtl: 59343, desc2: `[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]`,
    expect: ["1S"], note: "the PO raised from SO-000814; may already have followed the SO line above" },
];

const counts = {};
const bump = (op, key) => { (counts[op] ??= {}); counts[op][key] = (counts[op][key] || 0) + 1; };

/* Keep the CSV and this script from drifting: the mapping row is the reason the
   documents point at 8038, and the importers read it on every future run. */
function assertMappingFixed() {
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "");
  const row = csv.split(/\r?\n/).find((l) => l.startsWith("RDS-5526 SOFA,"));
  if (!row) throw new Error("mapping row for 'RDS-5526 SOFA' not found in autocount-erp-mapping-1561.csv");
  const erp = (row.split(",")[1] || "").trim();
  if (erp !== `${MODEL}-1S`) throw new Error(`mapping row still says "RDS-5526 SOFA -> ${erp}"; it must say ${MODEL}-1S before this runs`);
  note(`mapping CSV: RDS-5526 SOFA -> ${erp}  (importers strip -1S to read the model)`);
}

async function main() {
  assertMappingFixed();
  const [co] = await sql`SELECT id, code FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;
  note(`MODE=${MODE} company=HOUZS(${cid})`);

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    const prodRows = await tx`SELECT id, code, name, branding, base_model, model_id
                              FROM scm.mfg_products WHERE company_id = ${cid} AND category = 'SOFA'`;
    const prodByCode = new Map(prodRows.map((p) => [K(p.code), p]));
    const modelRows = await tx`SELECT id, model_code, name, allowed_options
                               FROM scm.product_models WHERE company_id = ${cid} AND category = 'SOFA'`;
    const modelByCode = new Map(modelRows.map((m) => [m.model_code, m]));
    const poolNeeded = new Set();

    // ---- 1. the model row ---------------------------------------------------
    let m5526 = modelByCode.get(MODEL);
    if (m5526) {
      note(`model ${MODEL} already exists ("${m5526.name}") — compartments only`);
      bump("model_create", "skip_exists");
    } else {
      const opts = { compartments: [] };
      const row = { id: null, model_code: MODEL, name: MODEL_NAME, allowed_options: opts };
      if (APPLY) {
        const [ins] = await tx`INSERT INTO scm.product_models
          (branding, model_code, name, category, allowed_options, active, company_id, created_at, updated_at)
          VALUES (${BRANDING}, ${MODEL}, ${MODEL_NAME}, 'SOFA', ${tx.json(opts)}, true, ${cid}, ${now}, ${now})
          RETURNING id`;
        row.id = ins.id;
      }
      modelByCode.set(MODEL, row);
      m5526 = row;
      bump("model_create", "apply");
      note(`create model ${MODEL}  name="${MODEL_NAME}"  branding="${BRANDING}"  category=SOFA`);
    }

    // ---- 2 + 3. compartments and SKUs --------------------------------------
    const groups = [{ model: MODEL, comps: COMPARTMENTS.map((x) => x.c), whyBy: new Map(COMPARTMENTS.map((x) => [x.c, x.why])) },
                    ...ALSO_OPEN.map((g) => ({ ...g, whyBy: new Map() }))];
    for (const g of groups) {
      const m = modelByCode.get(g.model);
      if (!m) { bump("model_open", "skip_no_model"); note(`  !! model ${g.model} not found — held`); continue; }
      const opts = { ...(m.allowed_options || {}) };
      const cur = new Set(opts.compartments || []);
      const add = g.comps.filter((c) => !cur.has(c));
      g.comps.forEach((c) => poolNeeded.add(c));
      if (add.length) {
        opts.compartments = [...(opts.compartments || []), ...add];
        if (APPLY && m.id) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(opts)}, updated_at = ${now} WHERE id = ${m.id}`;
        m.allowed_options = opts;
        bump("model_open", "apply");
        note(`  ${g.model} allowed_options.compartments += ${add.join(", ")}`);
      } else bump("model_open", "noop");

      for (const comp of g.comps) {
        const code = `${g.model}-${comp}`;
        if (prodByCode.has(K(code))) { bump("sku_mint", "skip_exists"); note(`  exists ${code}`); continue; }
        const sib = prodRows.find((p) => p.base_model === g.model && p.branding);
        const id = "mfg-" + randomBytes(6).toString("hex");
        const name = `SOFA ${m.name} ${comp}`.toUpperCase();
        if (APPLY) await tx`INSERT INTO scm.mfg_products
          (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
          VALUES (${id}, ${code}, ${name}, 'SOFA', 'ACTIVE', ${sib?.branding ?? BRANDING}, ${g.model}, ${m.id}, ${cid}, ${now}, ${now})`;
        prodByCode.set(K(code), { id, code, name });
        bump("sku_mint", "apply");
        const why = g.whyBy.get(comp);
        note(`  mint ${code}  "${name}"${why ? `   <- ${why}` : ""}`);
      }
    }

    // ---- 4. the master compartment pool ------------------------------------
    const [cfg] = await tx`SELECT id, config FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    if (!cfg) { note("no master maintenance_config_history row — pool step skipped"); bump("pool_append", "skip_no_config"); }
    else {
      const pool = new Set((cfg.config?.sofaCompartments || []).map((v) => (typeof v === "object" ? v.value : v)));
      const poolAdd = [...poolNeeded].filter((c) => !pool.has(c));
      if (poolAdd.length) {
        note(`pool additions (append-only): ${poolAdd.join(", ")}`);
        if (APPLY) {
          const nextCfg = { ...cfg.config, sofaCompartments: [...(cfg.config.sofaCompartments || []), ...poolAdd] };
          await tx`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
                   VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${tx.json(nextCfg)}, CURRENT_DATE,
                           ${"open 5526 model 2026-08-10: add " + poolAdd.join(", ")}, ${now}, ${cid})`;
        }
        bump("pool_append", "apply");
      } else { note("pool: every code already present"); bump("pool_append", "noop"); }
    }

    // ---- 5. re-point the nine document lines --------------------------------
    note("");
    note("re-point (AutoCount source line -> the ERP rows it produced):");
    let nRows = 0, nPo = 0, nGr = 0, nDo = 0;
    for (const e of REPOINT) {
      const doc = `HC-${e.ac}`;
      let poId = null;
      if (e.kind === "po") {
        /* POs were renumbered to follow AutoCount (#1875); linked_ac_docno is
           the fact that survives a renumber. */
        const [hit] = await tx`SELECT id, po_number FROM scm.purchase_orders
          WHERE company_id = ${cid} AND (po_number = ${doc} OR linked_ac_docno = ${e.ac}) LIMIT 1`;
        if (!hit) { note(`  ${doc}: not in the ERP under that number nor linked to ${e.ac} — skipped`); bump("repoint", "doc_absent"); continue; }
        poId = hit.id;
        if (hit.po_number !== doc) note(`  ${doc}: found as ${hit.po_number} via linked_ac_docno`);
      }
      const all = e.kind === "po"
        ? await tx`SELECT i.id, i.material_code AS code, i.description2, i.line_total_centi AS total
                     FROM scm.purchase_order_items i
                    WHERE i.purchase_order_id = ${poId} AND i.item_group = 'sofa' ORDER BY i.id`
        : await tx`SELECT i.id, i.item_code AS code, i.description2, i.total_centi AS total, i.line_no
                     FROM scm.mfg_sales_order_items i
                     JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                    WHERE h.company_id = ${cid} AND (i.doc_no = ${doc} OR h.linked_ac_docno = ${e.ac})
                      AND i.item_group = 'sofa' ORDER BY i.line_no`;
      const rows = all.filter((r) => String(r.description2 ?? "").includes(e.desc2));
      if (!rows.length) {
        /* Say WHY, so a missing build is diagnosable instead of a shrug: is the
           document in the ERP at all, and what groups are its lines in?
           (apply-sofa-compartment-corrections.mjs set this precedent.) */
        const probe = e.kind === "po"
          ? await tx`SELECT i.item_group g, COUNT(*)::int n FROM scm.purchase_order_items i
                      WHERE i.purchase_order_id = ${poId} GROUP BY 1`
          : await tx`SELECT i.item_group g, COUNT(*)::int n FROM scm.mfg_sales_order_items i
                      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                     WHERE h.company_id = ${cid} AND (i.doc_no = ${doc} OR h.linked_ac_docno = ${e.ac}) GROUP BY 1`;
        note(`  ${doc} dtl ${e.dtl}: ${all.length} sofa line(s), none holding this build — ${
          probe.length ? "document lines: " + probe.map((x) => `${x.g}:${x.n}`).join(", ") : "the document itself is not in the ERP"} — skipped`);
        bump("repoint", "build_absent"); continue;
      }
      const before = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
      /* `expect` is what parse-sofa.mjs makes of this Desc2. A difference is not
         fatal — the import ran against whatever SKUs existed that day, so a
         placeholder is a legitimate answer — but it must be visible. */
      const found = rows.map((r) => compOf(r.code));
      if (JSON.stringify(found) !== JSON.stringify(e.expect.map(K)))
        note(`  ${doc} dtl ${e.dtl}: NOTE — the document holds ${found.join("+") || "(none)"}, the decoder says ${e.expect.join("+")}`);

      const plan = [];
      let refused = null;
      for (const r of rows) {
        const mdl = modelOf(r.code), comp = compOf(r.code);
        if (mdl === MODEL) { plan.push({ row: r, to: r.code, noop: true }); continue; }
        if (mdl !== FROM_MODEL) { refused = `line ${r.code} is on model ${mdl}, not ${FROM_MODEL}`; break; }
        const target = e.remap?.[comp] ?? COMPARTMENTS.find((x) => K(x.c) === comp)?.c;
        if (!target) { refused = `no 5526 compartment for "${comp}" (${r.code})`; break; }
        const to = `${MODEL}-${target}`;
        if (!prodByCode.has(K(to))) { refused = `target SKU ${to} does not exist`; break; }
        plan.push({ row: r, to, noop: false });
      }
      if (refused) { note(`  ${doc} dtl ${e.dtl}: REFUSED — ${refused}`); bump("repoint", "refused"); continue; }

      note(`  ${doc} dtl ${e.dtl}  ${rows.map((r) => r.code).join(" + ")}`);
      note(`      -> ${plan.map((p) => p.to + (p.noop ? " (already)" : "")).join(" + ")}${e.note ? `   [${e.note}]` : ""}`);
      const touched = [];
      for (const p of plan) {
        if (p.noop) { bump("repoint", "already"); continue; }
        const name = prodByCode.get(K(p.to)).name;
        if (APPLY) {
          if (e.kind === "po") await tx`UPDATE scm.purchase_order_items
            SET material_code = ${p.to}, material_name = ${name} WHERE id = ${p.row.id}`;
          else await tx`UPDATE scm.mfg_sales_order_items
            SET item_code = ${p.to}, description = ${name} WHERE id = ${p.row.id}`;
        }
        touched.push({ id: p.row.id, code: p.to });
        nRows++; bump("repoint", "row");
      }

      /* Downstream documents took a SNAPSHOT of the code when they were created,
         so the parent alone would leave them stating 8038. These rows carry
         migrated_no_stock: this is paperwork, no movement is written. */
      const grnFollow = async (poItemId, code) => (APPLY
        ? tx`UPDATE scm.grn_items SET material_code = ${code} WHERE purchase_order_item_id = ${poItemId} RETURNING id`
        : tx`SELECT id FROM scm.grn_items WHERE purchase_order_item_id = ${poItemId}`);
      for (const t of touched) {
        if (e.kind === "po") {
          const g = await grnFollow(t.id, t.code);
          if (g.length) { nGr += g.length; note(`      -> ${g.length} GRN line(s) follow ${compOf(t.code)}`); }
        } else {
          const po = APPLY
            ? await tx`UPDATE scm.purchase_order_items SET material_code = ${t.code} WHERE so_item_id = ${t.id} RETURNING id`
            : await tx`SELECT id FROM scm.purchase_order_items WHERE so_item_id = ${t.id}`;
          if (po.length) {
            nPo += po.length;
            note(`      -> ${po.length} PO line(s) follow ${compOf(t.code)}`);
            for (const r of po) nGr += (await grnFollow(r.id, t.code)).length;
          }
          const d = APPLY
            ? await tx`UPDATE scm.delivery_order_items SET item_code = ${t.code} WHERE so_item_id = ${t.id} RETURNING id`
            : await tx`SELECT id FROM scm.delivery_order_items WHERE so_item_id = ${t.id}`;
          if (d.length) { nDo += d.length; note(`      -> ${d.length} DO line(s) follow ${compOf(t.code)}`); }
        }
      }

      /* Re-read the same build (description2 is never written, so it still
         selects the same rows) and prove the total is unchanged to the cent. */
      const reread = e.kind === "po"
        ? await tx`SELECT i.description2, i.line_total_centi AS total FROM scm.purchase_order_items i
                    WHERE i.purchase_order_id = ${poId} AND i.item_group = 'sofa'`
        : await tx`SELECT i.description2, i.total_centi AS total FROM scm.mfg_sales_order_items i
                     JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                    WHERE h.company_id = ${cid} AND (i.doc_no = ${doc} OR h.linked_ac_docno = ${e.ac})
                      AND i.item_group = 'sofa'`;
      const after = reread.filter((r) => String(r.description2 ?? "").includes(e.desc2))
        .reduce((s, r) => s + Number(r.total ?? 0), 0);
      if (after !== before) throw new Error(`${doc}: the money moved (${before} -> ${after}) — rolling back`);
    }

    note("");
    note(`re-pointed rows ${nRows} · downstream: PO ${nPo} · GRN ${nGr} · DO ${nDo}`);
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): ${JSON.stringify(counts)}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note("DRY-RUN complete: transaction rolled back, nothing written. MODE=apply CONFIRM=\"" + CONFIRM_PHRASE + "\" to write.");
  });
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
