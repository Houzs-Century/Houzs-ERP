#!/usr/bin/env node
/* Correct the mattress GAP on the bedframe lines whose AutoCount Desc2 wrote the
   divan height as "DIVAN GAP: N" AHEAD of the real "M.GAP" / "MATTRESS GAP".
   MODE=plan (default) reports and writes nothing; MODE=apply with
   CONFIRM="I HAVE REVIEWED THE DRY-RUN" writes. Runs on the shared runner
   (Actions -> "Run a backend script on production").

   WHY. parse-bedframe.mjs read an un-anchored GAP, so on
   "COL: PC151-12 /DIVAN GAP: 8"+NO LEGS / M.GAP: 12"" it grabbed the leading
   "DIVAN GAP: 8" and the real M.GAP: 12" never landed. The ERP then printed
   GAP 8" (and T.Heights = gap+divan+leg = 16") on the SO, its Delivery Order and
   every downstream doc. Owner 2026-09-21 on HC-SO-010005: "ERP record错了,
   M.Gap 12" 才是对的". The parser fold "DIVAN GAP" -> "DIVAN" fixes FUTURE parses;
   this heals the rows already stamped, which no refresh script sweeps for a DO /
   SI / GRN snapshot.

   SCOPE. Exactly the three SO lines the owner confirmed, and only their own
   descendants (DO / SI by so_item_id, PO by so_item_id, GRN by the PO line). A
   fourth "DIVAN GAP" line (HC-SO-000013, no mattress gap at all) was DELIBERATELY
   excluded by the owner and is not in TARGETS. The corrected numeric block is
   computed by re-parsing the SO's OWN Desc2 through the fixed parser (so code and
   data agree), and a per-doc EXPECTED_GAP guard refuses to write if the parse is
   not what we reviewed - a tripwire against running this against an unfixed
   parser or edited text.

   MERGE, NEVER REPLACE. `variants || patch` keeps every key this script does not
   own (fabricId, colourId, specials, ...); the UPDATE requires
   jsonb_typeof(variants) = 'object' because object || non-object CONCATENATES
   INTO AN ARRAY (docs/jsonb-double-encoding-coe.md). The inch COLUMNS are moved
   with a CASE that leaves a column NULL where the snapshot never populated one -
   a migrated DO/GRN reads its gap off variants, so we do not invent a column
   value it never had; we only correct a populated-but-wrong one (the SO/PO). The
   patch is bound with tx.json(), rows are counted from RETURNING, and every
   written row is re-read on a FRESH CONNECTION.

   RE-RUN: inert. Once a row holds the corrected gap the merge is a no-op and the
   read-back still passes. */
import postgres from "postgres";
import { parseBedframe } from "./lib/parse-bedframe.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply" || process.env.APPLY === "1";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const err = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);
const j = (v) => JSON.stringify(v);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  err(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* The owner-confirmed set (2026-09-21). EXPECTED_GAP is the reviewed answer the
   fixed parser must produce from that line's Desc2 before any write happens. */
const TARGETS = [
  { doc: "HC-SO-004193", line: 1, expectedGap: 13 },
  { doc: "HC-SO-010005", line: 2, expectedGap: 12 },
  { doc: "HC-SO-012921", line: 2, expectedGap: 12 },
];

const numOf = (v) => { const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(v ?? "")); return m ? parseFloat(m[1]) : null; };
const asObj = (v) => {
  let x = v;
  if (typeof x === "string") { try { x = JSON.parse(x); } catch { return null; } }
  if (Array.isArray(x)) return null;
  return x && typeof x === "object" ? x : null;
};
/* The numeric variant block, exactly as import-ac-outstanding-so.mjs builds it
   (totalHeight = gap + divan + leg), MINUS the colour keys — this script only
   ever touches the four measurement axes. */
const blockFor = (bf) => {
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
  };
};

/* One UPDATE shape per table (all four carry the same columns). Merges the patch
   into variants and moves the inch columns only where they were populated. */
async function updateRow(tx, tbl, id, patch, inch) {
  const set = (t) => t`
        SET variants = variants || ${tx.json(patch)},
            gap_inches          = CASE WHEN gap_inches          IS NULL THEN NULL ELSE ${inch.gap}   END,
            divan_height_inches = CASE WHEN divan_height_inches IS NULL THEN NULL ELSE ${inch.divan} END,
            leg_height_inches   = CASE WHEN leg_height_inches   IS NULL THEN NULL ELSE ${inch.leg}   END
      WHERE id = ${id}::uuid AND jsonb_typeof(variants) = 'object'
  RETURNING id::text AS id`;
  switch (tbl) {
    case "SO":  return tx`UPDATE scm.mfg_sales_order_items ${set(tx)}`;
    case "DO":  return tx`UPDATE scm.delivery_order_items ${set(tx)}`;
    case "SI":  return tx`UPDATE scm.sales_invoice_items ${set(tx)}`;
    case "PO":  return tx`UPDATE scm.purchase_order_items ${set(tx)}`;
    case "GRN": return tx`UPDATE scm.grn_items ${set(tx)}`;
    default: throw new Error(`unknown table ${tbl}`);
  }
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"}`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const soRows = await sql`
    SELECT id::text AS id, doc_no, line_no, company_id, description2,
           gap_inches AS gi, divan_height_inches AS di, leg_height_inches AS li, variants AS v
      FROM scm.mfg_sales_order_items
     WHERE item_group = 'bedframe' AND doc_no IN ${sql(TARGETS.map((t) => t.doc))}`;

  const plan = []; const refusals = [];
  for (const t of TARGETS) {
    const so = soRows.find((r) => r.doc_no === t.doc && Number(r.line_no) === t.line);
    if (!so) { refusals.push(`${t.doc} L${t.line}: SO bedframe line not found`); continue; }
    const bf = parseBedframe(so.description2);
    if (Number(bf.gap) !== t.expectedGap) {
      refusals.push(`${t.doc} L${t.line}: parsed gap ${bf.gap} != expected ${t.expectedGap} — REFUSED. text=${j((so.description2 || "").replace(/\s+/g, " ").trim())}`);
      continue;
    }
    const patch = blockFor(bf);
    const inch = { gap: bf.gap ?? null, divan: bf.divan ?? null, leg: bf.leg ?? null };
    const want = { gap: patch.gap, tot: patch.totalHeight };

    // SO line itself
    const add = (tbl, id, row) => {
      const v = asObj(row.v) || {};
      plan.push({
        doc: t.doc, line: t.line, tbl, id,
        before: { gap: v.gap ?? null, tot: v.totalHeight ?? null, gi: row.gi ?? null },
        patch, inch, want,
      });
    };
    add("SO", so.id, so);

    // descendants that snapshot this SO line
    const [dos, sis, pos] = await Promise.all([
      sql`SELECT id::text AS id, gap_inches AS gi, variants AS v FROM scm.delivery_order_items WHERE so_item_id = ${so.id}::uuid`,
      sql`SELECT id::text AS id, gap_inches AS gi, variants AS v FROM scm.sales_invoice_items  WHERE so_item_id = ${so.id}::uuid`,
      sql`SELECT id::text AS id, gap_inches AS gi, variants AS v FROM scm.purchase_order_items WHERE so_item_id = ${so.id}::uuid`,
    ]);
    for (const r of dos) add("DO", r.id, r);
    for (const r of sis) add("SI", r.id, r);
    for (const r of pos) add("PO", r.id, r);
    if (pos.length) {
      const grns = await sql`SELECT id::text AS id, gap_inches AS gi, variants AS v
                               FROM scm.grn_items WHERE purchase_order_item_id::text IN ${sql(pos.map((r) => r.id))}`;
      for (const r of grns) add("GRN", r.id, r);
    }
  }

  for (const r of refusals) err(r);
  log(`planned rows: ${plan.length} across ${new Set(plan.map((p) => p.doc)).size} SO`);
  for (const p of plan) {
    const changed = p.before.gap !== p.want.gap || p.before.tot !== p.want.tot;
    log(`   ${p.doc} L${p.line} ${p.tbl} ${p.id}  gap ${p.before.gap}->${p.want.gap}  total ${p.before.tot}->${p.want.tot}  ${changed ? "" : "(already correct)"}`);
  }
  if (refusals.length) { err(`${refusals.length} target(s) refused — aborting without writing.`); await sql.end(); process.exit(1); }

  if (!APPLY) { log(""); log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`); await sql.end(); return; }

  let returned = 0, missed = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await updateRow(tx, p.tbl, p.id, p.patch, p.inch);
      if (res.length) returned += res.length; else missed++;
    }
  });
  log(`rows returned by UPDATE: ${returned}; refused by the object-shape guard: ${missed}`);
  await sql.end();

  // ---- independent read-back, FRESH CONNECTION -------------------------------
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const readers = {
    SO:  (ids) => verify`SELECT id::text AS id, variants AS v FROM scm.mfg_sales_order_items WHERE id::text IN ${verify(ids)}`,
    DO:  (ids) => verify`SELECT id::text AS id, variants AS v FROM scm.delivery_order_items  WHERE id::text IN ${verify(ids)}`,
    SI:  (ids) => verify`SELECT id::text AS id, variants AS v FROM scm.sales_invoice_items   WHERE id::text IN ${verify(ids)}`,
    PO:  (ids) => verify`SELECT id::text AS id, variants AS v FROM scm.purchase_order_items  WHERE id::text IN ${verify(ids)}`,
    GRN: (ids) => verify`SELECT id::text AS id, variants AS v FROM scm.grn_items             WHERE id::text IN ${verify(ids)}`,
  };
  const byTbl = new Map();
  for (const p of plan) { if (!byTbl.has(p.tbl)) byTbl.set(p.tbl, []); byTbl.get(p.tbl).push(p.id); }
  const back = new Map();
  for (const [tbl, ids] of byTbl) for (const r of await readers[tbl](ids)) back.set(r.id, r.v);

  let ok = 0; const bad = [];
  for (const p of plan) {
    const v = asObj(back.get(p.id));
    if (!v) { bad.push(`${p.doc} ${p.tbl} ${p.id}: row missing or variants not an object`); continue; }
    if ((v.gap ?? null) !== p.want.gap || (v.totalHeight ?? null) !== p.want.tot)
      bad.push(`${p.doc} ${p.tbl} ${p.id}: still gap=${v.gap ?? null} total=${v.totalHeight ?? null}`);
    else ok++;
  }
  log("");
  log(`READ-BACK on a fresh connection: ${ok}/${plan.length} rows hold their corrected gap/total`);
  for (const b of bad) err(`READ-BACK FAILED — ${b}`);
  await verify.end();
  if (bad.length) { err(`${bad.length} rows did not take the write`); process.exit(1); }
  log("DONE. Every corrected row was re-read on a separate connection.");
}
main().catch((e) => { console.error(e); process.exit(1); });
