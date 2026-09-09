#!/usr/bin/env node
/* Make a line's special order name the option the CATALOGUE actually holds.
 *
 * 「一律跟账本」 and 「没有的才用 customs others 那边写进去」 — free text is for
 * what the picker has NO code for. Where a code exists, the line should carry
 * the code, or the reconcile reads the book asking for an option the line does
 * not tick and reports a difference that is really a spelling.
 *
 * HC-SO-013496 is the case: the book says `change 8030 back rest  Nilon bottom
 * HR 805-90`, the picker's own option is `Change 8030 Backcushion`, and the
 * line carries the free text `CHANGE8030BACKREST`. Measured on prod (probe run
 * 34249150622): `CHANGE8030BACKREST` is not a live option code in ANY category
 * — the only row that matches is `Change 8030 Backcushion` itself.
 *
 * ── THE MONEY CANNOT MOVE, AND THAT IS A CONDITION, NOT A HOPE ──────────────
 * Stamping a PRICED picker code onto a line is how a document reprices itself
 * on its next edit, which is the one thing the owner said must not happen — it
 * is why the 2026-09-03 ruling 甲 exists and why priced options are recorded in
 * a key of their own instead. This script therefore REFUSES any target whose
 * `selling_price_sen` or `cost_price_sen` is not zero. A free option cannot
 * reprice anything, so the whole class of harm is excluded by the gate rather
 * than checked for afterwards. A priced one is reported by name and left: it is
 * a different decision and it is the owner's.
 *
 * Three more refusals, all of them about not inventing anything:
 *   - the target must EXIST in scm.special_addons for this company;
 *   - it must be `active` — a retired option is not something to move a live
 *     line onto;
 *   - it must carry the line's own item-group category, so a bedframe option
 *     can never land on a sofa line.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * `variants.specials` only — the array the picker binds to. `custom_specials`
 * is DERIVED from it and is deliberately NOT touched: it is set to null
 * whenever `variants.specials` is empty, so writing into it directly puts a
 * value one edit away from vanishing. The reconcile reads both, so correcting
 * the input is the whole repair.
 *
 * MODE=plan by default. MODE=apply additionally needs
 * CONFIRM="I HAVE REVIEWED THE PLAN". Each line is its own transaction, and the
 * run ends by re-reading every touched line on a FRESH connection and asserting
 * the SHAPE: the specials array holds the target and no longer holds the old
 * spelling, and all three money columns are byte-identical to what they were.
 *
 * RE-RUN: inert. A line already carrying the target and not the old spelling is
 * reported as `already aligned` and nothing is written.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = String(process.env.MODE || "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const ONLY = (process.env.DOC || "").trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
/* Two LITERAL clients: the session that wrote is the worst witness that the
   write landed, so the verification opens its own. */
const PG = { ssl: "require", prepare: false, max: 1 };
const sql = postgres(DST, PG);

const list = JSON.parse(fs.readFileSync(path.join(here, "data", "line-specials-spelling.json"), "utf8"));

/** The same identity the parser and the reconcile dedupe on. */
const skey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
const asList = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const money = (r) => ({
  unit: Number(r.unit_price_sen ?? 0),
  total: Number(r.total_sen ?? 0),
  special: Number(r.special_order_price_sen ?? 0),
});
const sameMoney = (a, b) => a.unit === b.unit && a.total === b.total && a.special === b.special;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company=${CO}${ONLY ? ` DOC=${ONLY}` : ""}`);
  log(`allow-list: ${list.entries.length} line(s)`);

  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
                             FROM scm.special_addons WHERE company_id = ${CO}`;
  log(`catalogue: ${addons.length} option(s) for company ${CO}`);

  let nFixed = 0, nAlready = 0, nRefused = 0;
  const verify = [];

  for (const e of list.entries) {
    if (ONLY && e.doc !== ONLY) continue;
    const key = String(e.dtlKey).trim();
    const where = `${e.doc} dtl ${key}`;
    const refuse = (why) => { log(`  ${where}: REFUSED — ${why}`); nRefused++; };

    const target = addons.find((a) => String(a.code) === e.to);
    if (!target) { refuse(`the catalogue holds no option coded ${JSON.stringify(e.to)} for this company`); continue; }
    if (target.active !== true) { refuse(`${JSON.stringify(e.to)} is not active — a retired option is not somewhere to move a live line`); continue; }
    const price = Number(target.selling_price_sen ?? 0), cost = Number(target.cost_price_sen ?? 0);
    if (price !== 0 || cost !== 0) {
      refuse(`${JSON.stringify(e.to)} is PRICED (selling ${price}, cost ${cost}). Stamping a priced option onto a line can reprice the document on its next edit; that is the owner's ruling 甲 territory and a different decision`);
      continue;
    }

    const rows = await sql`SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.custom_specials,
                                  i.unit_price_sen, i.total_sen, i.special_order_price_sen, i.linked_ac_dtlkey
                             FROM scm.mfg_sales_order_items i
                            WHERE i.company_id = ${CO} AND i.doc_no = ${e.doc}
                              AND i.linked_ac_dtlkey::text = ${key}`;
    if (!rows.length) { refuse(`no line on ${e.doc} carries AutoCount DtlKey ${key}`); continue; }

    const cats = (target.categories || []).map((c) => String(c).toUpperCase());
    for (const r of rows) {
      const group = String(r.item_group ?? "").toUpperCase();
      if (group && !cats.includes(group)) {
        refuse(`${JSON.stringify(e.to)} is categorised ${JSON.stringify(cats)} and the line is ${JSON.stringify(group)} — a ${group.toLowerCase()} line must not take another category's option`);
        continue;
      }
      const v = { ...(r.variants ?? {}) };
      const have = asList(v.specials).map((x) => (typeof x === "string" ? x : x?.label ?? x?.code ?? String(x)));
      const hasTarget = have.some((x) => skey(x) === skey(e.to));
      const stale = have.filter((x) => skey(x) === skey(e.from));
      if (hasTarget && !stale.length) { log(`  ${where}: already aligned — the line carries ${JSON.stringify(e.to)}`); nAlready++; continue; }
      if (!stale.length && !hasTarget) { refuse(`the line carries neither ${JSON.stringify(e.from)} nor ${JSON.stringify(e.to)} — its specials are ${JSON.stringify(have)}`); continue; }

      /* Replace the stale spelling IN PLACE, keeping order and keeping every
         other special exactly as it is. Free text the picker has no code for
         is the owner's own instruction to keep (「没有的才用 customs others
         那边写进去」) and is not touched. */
      const after = [];
      let put = false;
      for (const x of have) {
        if (skey(x) === skey(e.from)) { if (!put && !hasTarget) { after.push(e.to); put = true; } continue; }
        after.push(x);
      }
      if (hasTarget && !after.some((x) => skey(x) === skey(e.to))) after.push(e.to);
      v.specials = after;

      const before = money(r);
      log(`  ${where}: ${r.item_code}  specials ${JSON.stringify(have)}`);
      log(`      ->            ${JSON.stringify(after)}`);
      log(`      ${JSON.stringify(e.to)} is a live SOFA option at selling 0 / cost 0, so no money can move; the line stays at unit ${before.unit}, total ${before.total}, special ${before.special}`);
      log(`      custom_specials is DERIVED and is left alone: ${JSON.stringify(r.custom_specials)}`);
      log(`      why: ${e.why}`);
      verify.push({ id: r.id, doc: e.doc, key, to: e.to, from: e.from, want: after, money: before });

      if (!APPLY) continue;
      await sql.begin(async (tx) => {
        await tx`UPDATE scm.mfg_sales_order_items SET variants = ${tx.json(v)} WHERE id = ${r.id}`;
      });
      nFixed++;
    }
  }

  log("");
  log(`lines aligned ${nFixed} · already aligned ${nAlready} · refused ${nRefused}`);
  await sql.end();
  if (!APPLY) { log("\nPLAN — set MODE=apply to write."); return; }
  await verifyOnFreshConnection(verify);
}

/**
 * Re-read every touched line on a NEW connection and assert the SHAPE: the
 * specials array is exactly what was planned, it carries the catalogue's code,
 * it no longer carries the old spelling, and all THREE money columns are
 * identical to what they were. A row count is not a shape.
 */
async function verifyOnFreshConnection(items) {
  if (!items.length) return;
  const v = postgres(DST, PG);
  log(`\nVERIFY — re-reading ${items.length} line(s) on a fresh connection`);
  let bad = 0;
  for (const it of items) {
    const [r] = await v`SELECT variants, unit_price_sen, total_sen, special_order_price_sen, item_code
                          FROM scm.mfg_sales_order_items WHERE id = ${it.id}`;
    const say = [];
    if (!r) say.push("the line is gone");
    else {
      const have = asList((r.variants ?? {}).specials).map((x) => (typeof x === "string" ? x : x?.label ?? x?.code ?? String(x)));
      if (JSON.stringify(have) !== JSON.stringify(it.want)) say.push(`specials are ${JSON.stringify(have)}, expected ${JSON.stringify(it.want)}`);
      if (!have.some((x) => skey(x) === skey(it.to))) say.push(`the catalogue's code ${JSON.stringify(it.to)} is not on the line`);
      if (have.some((x) => skey(x) === skey(it.from))) say.push(`the old spelling ${JSON.stringify(it.from)} is still on the line`);
      const now = money(r);
      if (!sameMoney(now, it.money)) say.push(`money moved: ${JSON.stringify(it.money)} -> ${JSON.stringify(now)}`);
    }
    if (!say.length) { log(`  OK  ${it.doc} dtl ${it.key}  ${JSON.stringify(it.want)}  money unchanged`); continue; }
    bad++;
    for (const s of say) log(`  FAIL ${it.doc} dtl ${it.key}: ${s}`);
  }
  await v.end();
  if (bad) { console.error(`VERIFY FAILED on ${bad} line(s)`); process.exit(1); }
  log(`VERIFY OK — ${items.length} line(s): the picker's own code is on the line, the free-text spelling is gone, and all three money columns are unchanged`);
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
