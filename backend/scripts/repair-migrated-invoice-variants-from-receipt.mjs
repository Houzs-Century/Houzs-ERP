#!/usr/bin/env node
/* repair-migrated-invoice-variants-from-receipt — give a migrated purchase-
 * invoice line back the colour and heights of the RECEIPT LINE it was copied
 * from, where the copy came out empty.
 *
 * 白话. 我们的采购发票是照着收货单一行一行抄下来的。有些发票抄的时候,收货单那一行
 * 的颜色和高度还是空的 —— 后来补上了,发票没有跟着补。所以现在发票上是空的,收货单
 * 上有。这里就是把收货单已经有的那份抄回发票,只补空的,不改任何已经填好的东西,
 * 也不动钱、数量、货号。
 *
 * ── THE FINDING, MEASURED ──────────────────────────────────────────────────
 * `diag-pi-line-provenance.mjs`, run 34377138255, over the 40 purchase invoices
 * the tally locks for a reason other than the outstanding-only scope: 137 ERP
 * invoice lines, every one linked to a receipt line, and
 *
 *     18 lines on 11 documents hold `variants = null` while the receipt line
 *        they point at holds the full object.
 *
 * `HC-PI-006244` is the clean example. Our invoice line reads
 * `variants=null, d2=""`; its receipt line `HC-GR-004126` key 745317 reads
 * `{"gap":"12\"","colourId":"PC151-14","legHeight":"2\"","divanHeight":"10\"",
 * "totalHeight":"24\"", ...}` — which is, value for value, what the reconcile
 * reports the BOOK stating and our invoice missing.
 *
 * ── WHY THE COPY IS EMPTY, AND WHY THIS IS NOT THE CREATOR'S BUG ──────────
 * `create-migrated-invoices.mjs` `writePi` has written `variants: l._row.variants`
 * since the first version of the file (`git log -S`, commit 76962abb7), and it
 * still does. So the invoice took a faithful SNAPSHOT of a receipt line that
 * was empty AT THE TIME, and the receipt was filled afterwards — the fabric and
 * height backfills of 2026-09-02..09 — with nothing carrying the new value
 * onto the invoice raised from it. That is docs/bugs/0687's class exactly, the
 * one where a sofa-compartment correction reached `grn_items` and not the
 * invoice; `repair-invoice-item-from-parent.mjs` fixed the ITEM CODE half and
 * says in its own header that it leaves `variants` alone, because at the time
 * docs/bugs/0672 recorded the colour comparison as invalid. It no longer is
 * (docs/bugs/0755, docs/bugs/0756). This is that half.
 *
 * The invoices created most recently show the same code working: `HC-PI-007968`
 * carries its receipt's variants verbatim on every line.
 *
 * ── WHAT IT WRITES, AND WHAT IT CANNOT ─────────────────────────────────────
 * One column: `scm.purchase_invoice_items.variants`, and only the keys of
 * `OWNED_PI_SNAPSHOT_KEYS` — its OWN list, not a widening of a sweep's
 * (docs/bugs/0755). `specials` and `special` are deliberately NOT in it, and
 * that absence is the money guard: a picked add-on's surcharge folds into the
 * authoritative unit price, so a priced code stamped on a historical line
 * reprices the document on its next edit, which the owner ruled out on
 * 2026-08-11. A parent that carries one cannot leak it through this copy.
 *
 * A parent key that is in NEITHER the owned list nor the withheld list makes
 * the row REFUSE rather than be written with a partial patch — an unknown key
 * is a fact about the data, not something to drop quietly.
 *
 * No quantity, no price, no discount, no cost, no item code, no link, no
 * status, no header total, and no `description2`. `description2` is left alone
 * on purpose: it is what the sofa decoder reads, so filling it can move a
 * `sofa build` verdict, and that belongs to the owner's lane and not to a
 * copy job. The plan REPORTS the invoice lines whose `description2` is blank
 * while the receipt's is not, and writes none of them.
 *
 * ── IT IS A FILL, NEVER AN OVERWRITE ───────────────────────────────────────
 * The UPDATE carries `COALESCE(variants,'{}'::jsonb) = '{}'::jsonb` in its
 * WHERE (lib/variant-merge.mjs), so a line somebody has since given a value
 * keeps it, and the run reports the row as skipped rather than counting it.
 * The plan is re-resolved at apply time and refuses on a PLAN DIGEST that has
 * moved, so a database that changed in between is a refusal and not a stale
 * write.
 *
 * RE-RUN: a no-op. The second run finds every planned line already holding an
 * object, classifies it `already filled`, writes nothing and reports 0.
 *
 * Env: DATABASE_URL (required)   MODE=plan|apply (default plan)
 *      CONFIRM (apply only, must be 'copy the receipt line onto the invoice')
 *      PLAN_DIGEST (apply only, from the plan run)
 *      COMPANY_ID (default 1)
 *      DOCS  optional comma-separated AutoCount purchase-invoice numbers. The
 *            company is live and staff are working, so a narrow DOC-scoped run
 *            is the default habit; blank means every migrated invoice line of
 *            the company that is in this shape, which the plan prints whole.
 */
import crypto from "node:crypto";
import postgres from "postgres";
import { mergeVariantPatch, OWNED_PI_SNAPSHOT_KEYS } from "./lib/variant-merge.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const PHRASE = "copy the receipt line onto the invoice";
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${PHRASE}' — refusing to write.`);
  process.exit(2);
}

const say = (m) => console.log(m);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Keys a parent may carry that this writer refuses to copy, each for a stated
   reason. Anything in NEITHER list makes the row refuse. */
const WITHHELD = Object.freeze({
  specials: "priced add-on codes fold into the authoritative unit price",
  special: "the HOOKKA-compatible singular of the same thing",
  specialsRecorded: "the owner's money-neutral record, written by its own script",
  customSpecials: "derived, and erased by the next recompute",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => isObj(v) && Object.keys(v).length > 0;

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function buildPlan() {
  const rows = await sql`
    SELECT h.linked_ac_docno AS ac_no, h.invoice_number AS erp_no, h.created_at AS invoice_created_at,
           i.id::text AS id, i.item_code, i.qty::float8 AS qty, i.variants,
           i.description2, i.item_group, i.linked_ac_dtlkey::text AS line_key,
           gi.id::text AS gr_item_id, gi.item_code AS gr_item_code,
           gi.variants AS gr_variants, gi.description2 AS gr_description2,
           g.grn_number AS gr_erp_no, g.status AS gr_status,
           g.linked_ac_gr_docno AS gr_ac_no
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      JOIN scm.grns g ON g.id = gi.grn_id
     WHERE i.company_id = ${CO} AND h.company_id = ${CO}
       AND h.linked_ac_docno IS NOT NULL
       AND (${DOCS.length === 0}::boolean OR h.linked_ac_docno = ANY(${DOCS}))
     ORDER BY h.linked_ac_docno, i.created_at, i.id`;

  const plan = [];
  const skipped = [];
  const desc2Gap = [];
  for (const r of rows) {
    const mine = r.variants;
    const theirs = r.gr_variants;
    const head = `${r.ac_no} ${r.item_code}`;
    if (mine !== null && !isObj(mine)) { skipped.push(`${head}: our variants is not a jsonb object (#1938 owns that shape)`); continue; }
    if (nonEmpty(mine)) continue;                       /* already has a value — not ours */
    if (!nonEmpty(theirs)) continue;                    /* nothing to copy */
    if (!isObj(theirs)) { skipped.push(`${head}: the receipt's variants is not a jsonb object`); continue; }

    const patch = {};
    const withheld = [];
    let unknown = null;
    for (const [k, v] of Object.entries(theirs)) {
      if (OWNED_PI_SNAPSHOT_KEYS.includes(k)) { patch[k] = v; continue; }
      if (k in WITHHELD) { withheld.push(k); continue; }
      unknown = k; break;
    }
    if (unknown) {
      skipped.push(`${head}: the receipt line carries a key this writer neither owns nor withholds (${JSON.stringify(unknown)}) — REFUSED rather than copied in part`);
      continue;
    }
    if (!Object.keys(patch).length) { skipped.push(`${head}: every key of the receipt's variants is withheld (${withheld.join(", ")}) — nothing to copy`); continue; }
    plan.push({ ...r, patch, withheld });

    const d2mine = String(r.description2 ?? "").trim();
    const d2theirs = String(r.gr_description2 ?? "").trim();
    if (!d2mine && d2theirs) desc2Gap.push(`${head}: our description2 is blank, the receipt's is ${JSON.stringify(d2theirs.slice(0, 90))}`);
  }
  return { rows, plan, skipped, desc2Gap };
}

/* The digest is over what the apply is about to write, so a book, a parent row
   or a line that moved between plan and apply refuses instead of writing a
   stale patch. */
const digestOf = (plan) => crypto.createHash("sha256").update(
  JSON.stringify(plan.map((p) => [p.id, p.gr_item_id, Object.entries(p.patch).sort()])),
).digest("hex").slice(0, 16);

async function main() {
  say(`mode=${MODE}; company ${CO}; ${DOCS.length ? `${DOCS.length} named document(s)` : "every migrated purchase invoice of this company"}`);
  say(`owned keys: ${OWNED_PI_SNAPSHOT_KEYS.join(", ")}`);
  say(`withheld:   ${Object.entries(WITHHELD).map(([k, w]) => `${k} (${w})`).join("; ")}`);
  say("");

  const { rows, plan, skipped, desc2Gap } = await buildPlan();
  say(`${rows.length} migrated invoice line(s) read, each with the receipt line it was built from.`);
  say("");
  say("═════════ THE LINES WHOSE COPY CAME OUT EMPTY ═════════");
  for (const p of plan) {
    say(`   ${p.ac_no} (ERP ${p.erp_no}) ${p.item_code} qty ${p.qty} [${p.item_group ?? "-"}] key ${p.line_key ?? "NONE"}`);
    say(`      from ${p.gr_erp_no} [${p.gr_status}] ac=${p.gr_ac_no ?? "(unlinked)"} ${p.gr_item_code}`);
    say(`      would write ${JSON.stringify(p.patch)}`);
    if (p.withheld.length) say(`      WITHHELD from the copy: ${p.withheld.join(", ")}`);
    say(`      invoice created ${p.invoice_created_at instanceof Date ? p.invoice_created_at.toISOString() : String(p.invoice_created_at)}`);
  }
  say("");
  if (skipped.length) {
    say("═════════ REFUSED OR SKIPPED, NAMED ═════════");
    for (const s of skipped) say(`   ${s}`);
    say("");
  }
  if (desc2Gap.length) {
    say("═════════ REPORTED AND NOT WRITTEN — description2 ═════════");
    say("   The sofa decoder reads description2, so filling it can move a `sofa build` verdict.");
    say("   That is the owner's lane, not a copy job. Listed so it does not hide:");
    for (const d of desc2Gap) say(`   ${d}`);
    say("");
  }

  const digest = digestOf(plan);
  const docs = [...new Set(plan.map((p) => p.ac_no))];
  log(`PLAN: ${plan.length} invoice line(s) on ${docs.length} document(s) would take their receipt line's colour and heights.`);
  log(`nothing else is touched: no quantity, no price, no discount, no cost, no item code, no link, no status, no description2`);
  log(`PLAN DIGEST: ${digest}`);

  if (!APPLY) {
    say("");
    log(`MODE=plan — nothing was written. To apply:`);
    log(`   MODE=apply CONFIRM='${PHRASE}' PLAN_DIGEST=${digest}`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (process.env.PLAN_DIGEST !== digest) {
    console.error(`PLAN_DIGEST mismatch: this run computes ${digest}, you passed ${JSON.stringify(process.env.PLAN_DIGEST ?? "")}.`);
    console.error("The database or the plan has moved since the plan run. Re-plan and re-read it; a stale plan is not applied here.");
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  let written = 0;
  const notWritten = [];
  for (const p of plan) {
    const n = await mergeVariantPatch(sql, {
      table: "purchase_invoice_items", id: p.id, patch: p.patch, owned: OWNED_PI_SNAPSHOT_KEYS,
    });
    if (n) written++;
    else notWritten.push(`${p.ac_no} ${p.item_code} (${p.id}) — the fill predicate no longer matched; somebody filled it in between, or the column is not an object`);
  }
  log(`APPLIED: ${written} of ${plan.length} invoice line(s) filled.`);
  for (const m of notWritten) say(`   NOT WRITTEN: ${m}`);
  await sql.end({ timeout: 5 });

  /* ── verify on a FRESH connection, and assert the SHAPE ───────────────────
     A row count answers "did a statement run", never "does the row hold what I
     meant" — the distinction that let a repair reproduce the jsonb
     double-encoding bug on 7 production rows while counting 7 of 7. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let ok = 0; const bad = [];
  for (const p of plan) {
    const [r] = await v`SELECT variants, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS kind,
                               qty::float8 AS qty, unit_price_sen, line_total_sen, discount_sen,
                               item_code, grn_item_id::text AS grn_item_id
                          FROM scm.purchase_invoice_items WHERE id = ${p.id}::uuid`;
    const why = [];
    if (!r) why.push("the row is gone");
    else {
      if (r.kind !== "object") why.push(`variants is jsonb ${r.kind}, not an object`);
      else for (const [k, want] of Object.entries(p.patch)) {
        const got = r.variants?.[k] ?? null;
        if (JSON.stringify(got) !== JSON.stringify(want ?? null)) why.push(`${k} reads ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
      }
      for (const k of Object.keys(WITHHELD)) if (r.variants && k in r.variants) why.push(`${k} appeared on the row, and this writer must never write it`);
      if (r.item_code !== p.item_code) why.push(`item_code moved: ${JSON.stringify(p.item_code)} -> ${JSON.stringify(r.item_code)}`);
      if (String(r.grn_item_id) !== String(p.gr_item_id)) why.push(`the receipt link moved`);
      if (Number(r.qty) !== Number(p.qty)) why.push(`qty moved: ${p.qty} -> ${r.qty}`);
    }
    if (why.length) bad.push(`${p.ac_no} ${p.item_code}: ${why.join("; ")}`);
    else ok++;
  }
  await v.end({ timeout: 5 });
  if (bad.length) {
    for (const b of bad) console.error(`VERIFY FAILED — ${b}`);
    console.error(`REFUSING to report success: ${bad.length} invoice line(s) do not hold what was written.`);
    process.exit(1);
  }
  log(`VERIFIED on a fresh connection: ${ok} invoice line(s) hold the receipt's own values, every one still a jsonb OBJECT, and item code, quantity and receipt link unchanged on all of them.`);
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closing */ } process.exit(1); });
