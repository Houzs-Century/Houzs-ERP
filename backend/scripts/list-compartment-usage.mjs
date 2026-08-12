#!/usr/bin/env node
// READ-ONLY — every document line carrying a given sofa compartment code, named
// by document, so the owner can open each one and read the DIRECTION off the
// line's own photo.
//
// WHY THIS EXISTS, AND WHY IT IS NOT probe-csl-console.mjs
//
// probe-csl-console answers "how big is the blast radius" — counts per table,
// SKU clashes, whether the cascade function exists. That is the right question
// before a rename. It is the WRONG question here, because the owner's problem
// is not size, it is AMBIGUITY: the pool carries a bare `1B` whose description
// is "(no design - leave blank)", and the replacement he wants exists in two
// forms that are physically different products:
//
//     1B(LHF)   1 seat - LEFT is Seat Cushion (bench), no arm on the right
//     1B(RHF)   1 seat - RIGHT is Seat Cushion (bench), no arm on the left
//
// A bare `1B` records no side. Nothing in the database can recover it, so no
// script may pick one — that is the owner's standing rule (a migration copies
// the source's own value and SKIPS what is ambiguous; it never infers). The
// owner's answer was "look at the photo". This script is what makes that
// possible: it names the documents and says which lines actually have a photo.
//
// THE SIBLING HINT IS A HINT. For a sofa build the script also prints the OTHER
// compartments on the same build. A build reading `1A(LHF) + 2A + 1B` strongly
// suggests the 1B sits at the right end — but suggests is all it does, and it
// is printed as evidence for a human, never applied.
//
// Writes NOTHING. The session is pinned read-only at connect time so a coding
// mistake cannot write even by accident. Exits 0 for every legitimate answer —
// the ANSWER is the output; only an unreachable DB or a query error exits non-zero.

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const CO = Number(process.env.COMPANY_ID || 1);
const CODES = (process.env.CODES || "1B,2B").split(",").map((s) => s.trim()).filter(Boolean);

// Codes arrive from workflow_dispatch and are interpolated into unsafe() SQL
// (the pattern positions cannot be parameterised). Compartment codes are a
// closed alphabet — anything else is REFUSED rather than escaped, so no
// dispatch input can reach the planner as syntax.
const CODE_RE = /^[A-Za-z0-9()/\-]{1,32}$/;
for (const c of CODES) {
  if (!CODE_RE.test(c)) { console.error(`CODES contains '${c}', which is not a valid compartment code`); process.exit(2); }
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (s = "") => console.log(s);

// Document lines that carry a compartment as the SKU suffix. Same (table,
// column) set probe-csl-console uses for the SO/downstream arms, trimmed to the
// documents a compartment can actually appear on as a sofa module line.
const DOC_TABLES = [
  ["mfg_sales_order_items",  "item_code",     "doc_no",   "Sales Order"],
  ["delivery_order_items",   "item_code",     "doc_no",   "Delivery Order"],
  ["sales_invoice_items",    "item_code",     "doc_no",   "Sales Invoice"],
  ["delivery_return_items",  "item_code",     "doc_no",   "Delivery Return"],
  ["purchase_order_items",   "material_code", "po_number","Purchase Order"],
  ["grn_items",              "material_code", "grn_no",   "Goods Receipt"],
];

const tableExists = async (t) =>
  (await sql`SELECT 1 FROM information_schema.tables WHERE table_schema='scm' AND table_name=${t}`).length > 0;
const colExists = async (t, c) =>
  (await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} AND column_name=${c}`).length > 0;

async function main() {
  await sql.unsafe("SET default_transaction_read_only = on");
  out(`=== compartment usage (READ-ONLY) — company ${CO} — codes: ${CODES.join(", ")} ===`);

  // ── 0. Is the code even in the live pool, and what does it claim to be? ──
  out("\n=== 0. live master pool ===");
  const pool = await sql`
    SELECT h.id, h.effective_from,
           h.config->'sofaCompartments'    AS comps,
           h.config->'sofaCompartmentMeta' AS meta
      FROM maintenance_config_history h
     WHERE h.scope='master' AND h.effective_from <= CURRENT_DATE
     ORDER BY h.effective_from DESC, h.created_at DESC
     LIMIT 1`;
  if (!pool.length) out("NO live master config row.");
  else {
    const comps = Array.isArray(pool[0].comps) ? pool[0].comps : [];
    const meta = pool[0].meta || {};
    out(`row=${pool[0].id} effective_from=${pool[0].effective_from} — pool has ${comps.length} compartments`);
    for (const c of CODES) {
      const desc = meta?.[c]?.description ?? meta?.[c]?.label ?? null;
      out(`  '${c}': in pool = ${comps.includes(c)}${desc ? ` — ${JSON.stringify(desc)}` : " — no description"}`);
    }
    // The candidate replacements, so the report states what the choice is BETWEEN.
    const kin = comps.filter((x) => CODES.some((c) => x !== c && x.startsWith(c) && /\((LHF|RHF)\)$/.test(x)));
    if (kin.length) {
      out(`  candidate replacements present in the pool: ${kin.join(", ")}`);
      for (const k of kin) {
        const d = meta?.[k]?.description ?? meta?.[k]?.label ?? null;
        if (d) out(`    ${k} — ${JSON.stringify(d)}`);
      }
    }
  }

  // ── 1. Which documents carry it, per document type ──────────────────────
  for (const code of CODES) {
    out(`\n${"=".repeat(70)}`);
    out(`=== CODE '${code}' ===`);
    const suffixLen = code.length + 1;

    for (const [t, col, docCol, human] of DOC_TABLES) {
      if (!(await tableExists(t)) || !(await colExists(t, col))) { out(`\n-- ${human}: table/column absent, skipped`); continue; }
      const hasCompany = await colExists(t, "company_id");
      const hasPhotos  = await colExists(t, "photo_urls");
      const hasDesc2   = await colExists(t, "description2");

      // Case-SENSITIVE match is the truth (the engine matches case-sensitively);
      // a case-insensitive count is reported beside it so a casing split cannot
      // hide behind a zero.
      const q = `
        SELECT i."${docCol}"::text          AS doc,
               i."${col}"::text             AS item_code,
               coalesce(i.description,'')   AS descr,
               ${hasDesc2 ? "coalesce(i.description2,'')" : "''"} AS descr2,
               ${hasPhotos ? "coalesce(array_length(i.photo_urls,1),0)" : "0"} AS photos
          FROM scm."${t}" i
         WHERE right(coalesce(i."${col}",''), ${suffixLen}) = '-${code}'
           ${hasCompany ? `AND i.company_id = ${CO}` : ""}
         ORDER BY 1, 2`;
      const rows = await sql.unsafe(q);

      const qi = `
        SELECT count(*)::int AS n FROM scm."${t}" i
         WHERE upper(right(coalesce(i."${col}",''), ${suffixLen})) = upper('-${code}')
           ${hasCompany ? `AND i.company_id = ${CO}` : ""}`;
      const [{ n: ci }] = await sql.unsafe(qi);

      out(`\n-- ${human} (${t}.${col}) — ${rows.length} line(s)${ci !== rows.length ? `  [case-insensitive would match ${ci} — CASING SPLIT]` : ""}`);
      if (!rows.length) continue;

      const byDoc = new Map();
      for (const r of rows) {
        if (!byDoc.has(r.doc)) byDoc.set(r.doc, []);
        byDoc.get(r.doc).push(r);
      }
      out(`   ${byDoc.size} document(s):`);
      for (const [doc, ls] of byDoc) {
        const withPhoto = ls.filter((l) => l.photos > 0).length;
        out(`   ${doc}  (${ls.length} line${ls.length > 1 ? "s" : ""}, ${withPhoto} with photo${hasPhotos ? "" : " — column absent"})`);
        for (const l of ls) {
          out(`      ${l.item_code}  photos=${l.photos}`);
          if (l.descr)  out(`         desc : ${l.descr.slice(0, 110)}`);
          if (l.descr2) out(`         desc2: ${l.descr2.slice(0, 110)}`);
        }
      }
    }

    // ── 2. The sibling hint, SO only — what else is on that build? ─────────
    // A build's other compartments are the strongest available evidence of which
    // END the bare code sits at. Evidence for a human. Never applied.
    if (await tableExists("mfg_sales_order_items")) {
      out(`\n-- build context for '${code}' (SO only) — the other compartments on the same order`);
      const ctx = await sql.unsafe(`
        WITH hit AS (
          SELECT DISTINCT doc_no FROM scm.mfg_sales_order_items
           WHERE right(coalesce(item_code,''), ${suffixLen}) = '-${code}'
             AND company_id = ${CO}
        )
        SELECT i.doc_no::text AS doc,
               string_agg(DISTINCT substring(i.item_code from '[^-]+$'), ' + ' ORDER BY substring(i.item_code from '[^-]+$')) AS parts
          FROM scm.mfg_sales_order_items i JOIN hit ON hit.doc_no = i.doc_no
         WHERE i.company_id = ${CO}
         GROUP BY 1 ORDER BY 1`);
      for (const r of ctx) out(`   ${r.doc}: ${r.parts}`);
      if (!ctx.length) out("   (none)");
    }

    // ── 3. Which of those documents are already gone past editing ──────────
    if (await tableExists("mfg_sales_orders")) {
      out(`\n-- SO status for '${code}' — a shipped/invoiced order is history, not a candidate for rewriting`);
      const st = await sql.unsafe(`
        SELECT s.status::text AS status, count(DISTINCT s.doc_no)::int AS docs
          FROM scm.mfg_sales_orders s
         WHERE s.company_id = ${CO}
           AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_items i
                        WHERE i.doc_no = s.doc_no
                          AND right(coalesce(i.item_code,''), ${suffixLen}) = '-${code}')
         GROUP BY 1 ORDER BY 2 DESC`);
      if (!st.length) out("   (no SO carries it)");
      for (const r of st) out(`   ${r.status}: ${r.docs} document(s)`);
    }
  }

  out(`\n${"=".repeat(70)}`);
  out("NEXT: open each Sales Order above in the ERP and read the DIRECTION off the");
  out("line's photo. This script does not and must not guess it. Once the owner has");
  out("ruled per document, the rename itself goes through");
  out("POST /api/scm/maintenance-config/sofa-compartments/rename, which is atomic");
  out("across the SKU master, every doc-line snapshot, allowed-options, combos,");
  out("quick picks, carts and the config blobs. Run probe-csl-console.mjs FIRST to");
  out("confirm that function exists in this database and that no SKU clash aborts it.");

  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
