#!/usr/bin/env node
/* check-stock-value-vs-autocount — does our inventory VALUE equal AutoCount's,
 * and if not, exactly where does the difference sit?
 *
 * Owner, 2026-09-09: 「最重要的是一定要跟 AutoCount 一样，要不然我的 balance sheet
 * 之后做的时候会不准、不一样。你只要跟 AutoCount 一样就没问题了」 — so the number
 * that matters is the one his balance sheet will carry, and a total that agrees
 * by coincidence is worth nothing. This reports the TOTAL and then every item
 * that moves it, largest first.
 *
 * ── THE AUTOCOUNT SIDE, AND THE FILE THAT LOOKS RIGHT AND IS NOT ──────────
 * `data/ac-stock-value-2026-09-10.json.gz` is `StockDTL` grouped by
 * (ItemCode, Location): `SUM(Qty)` is the balance and `SUM(Qty * Cost)` is its
 * value under AutoCount's OWN costing. No average, no re-derivation.
 *
 * It is NOT `data/ac-utd-stock-cost.json.gz`, which is already committed and
 * would have been the obvious file to reach for. That one reports 736 units and
 * RM 100,169 across 1,352 rows and leads with `TRANSPORTATION CHARGES` at -373:
 * it is a UTD-cost extract for a different question. Comparing a balance sheet
 * against it produces a confident wrong answer, which is the most expensive kind.
 *
 * ── WHAT IS OUT OF SCOPE, ON THE OWNER'S WORD ─────────────────────────────
 * SERVICE items. Owner, 2026-09-09: 「那个 Service 的东西，AutoCount 那边是不需要
 * 进来的。因为那个 AutoCount 它还在算着库存，我们不用理它」. The book still
 * carries a stock balance for them; we do not, and that is not a difference. The
 * classification is `SERVICE_GROUPS` in `lib/ac-stock-compare.mjs`, shared with
 * the quantity reconcile so one list decides it for both.
 *
 * ── THREE THINGS THAT ARE DEFINITIONAL, NOT DEFECTS ──────────────────────
 * Each is separated and SUBTRACTED from the headline before any item is called
 * a difference, because folding them in would make the total look wrong for
 * reasons nobody needs to chase:
 *
 *   CONSIGNMENT   the owner's rule (2026-07-25) is that consignment stock shows
 *                 QUANTITY and is excluded from VALUE. AutoCount values it.
 *   NEGATIVE      the book holds 45 cells at a negative balance. That is
 *                 AutoCount's own disagreement with itself; it is reported, and
 *                 never quietly netted off.
 *   ZERO-COST     lots we could not price (the book never priced them either).
 *                 They carry quantity and no value on our side.
 *
 * ── SOFA IS FOLDED ────────────────────────────────────────────────────────
 * The book prices a whole sofa; we hold compartments. Comparing them piece by
 * piece would report every sofa as a difference in both directions at once. The
 * fold is `lib/sofa-piece-fold.mjs`, the same module the quantity reconcile
 * uses — owner ruling 2026-09-07, and it changes nothing about how sofa stock is
 * stored.
 *
 * READ-ONLY: SELECTs only, no DDL, no writes, no transaction. Every legitimate
 * answer exits 0 — the answer is the output, not the exit code.
 *
 * RE-RUN: read-only, so a second run changes nothing and reports the same unless
 * the data moved or a fresher AutoCount export was committed.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)   TOP (default 40)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { SERVICE_GROUPS, loadAcBinding } from './lib/ac-stock-compare.mjs';
import { readMappingCsv, normCode } from './lib/ac-mapping-csv.mjs';
import { sofaModelOf, makeModelMatcher } from './lib/sofa-piece-fold.mjs';

const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const norm = normCode;
const rm = (sen) => `RM ${(sen / 100).toFixed(2)}`;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const SNAP = path.join(here, 'data', 'ac-stock-value-2026-09-10.json.gz');
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing — it is the AutoCount stock valuation and `
    + 'this runner cannot reach the book. Nothing was compared.');
  process.exit(1);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8').replace(/^﻿/, ''));

const mapping = readMappingCsv(fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8'));
const { byAc } = loadAcBinding(fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8'));
const erpCodeOf = (ac) => norm(mapping.get(norm(ac))?.erp || ac);
const groupOf = (ac) => (mapping.get(norm(ac))?.cat ?? '');
const isService = (ac) => SERVICE_GROUPS.has(norm(groupOf(ac)));

/* The sofa models, taken from the binding sheet's own SOFA rows: each maps to
   our base code `<model>-1S`, so stripping that suffix IS the model list. The
   matcher is longest-prefix, because `SOFA` and `SOFA-333 44` are both models
   and `startsWith` alone would answer the shorter one (lib/sofa-piece-fold.mjs). */
const sofaModels = new Set();
for (const [acCode, erpCode] of byAc) {
  if (norm(groupOf(acCode)) !== 'SOFA') continue;
  const m = sofaModelOf(erpCode);
  if (m) sofaModels.add(m);
}
const matchModel = makeModelMatcher(sofaModels);
/** One comparison key per physical product: a sofa compartment folds to its
 *  model, everything else is its own ERP code. */
const foldKey = (erp) => matchModel(erp) ?? norm(erp);
const isSofaKey = (k) => sofaModels.has(norm(k));

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`company ${CO}   AutoCount export ${snap.exported_at}`);
  log(`mapping rows: ${byAc.size}`);

  /* ── AutoCount side ────────────────────────────────────────────────────── */
  const ac = new Map();
  let acService = { qty: 0, sen: 0, cells: 0 };
  let acNegative = { qty: 0, sen: 0, cells: 0 };
  let acUnmapped = { qty: 0, sen: 0, codes: new Set() };
  for (const c of snap.cells) {
    if (isService(c.item)) { acService.qty += c.qty; acService.sen += c.value_sen; acService.cells += 1; continue; }
    if (c.qty < 0) { acNegative.qty += c.qty; acNegative.sen += c.value_sen; acNegative.cells += 1; continue; }
    if (!mapping.has(norm(c.item))) { acUnmapped.qty += c.qty; acUnmapped.sen += c.value_sen; acUnmapped.codes.add(c.item); }
    const k = foldKey(erpCodeOf(c.item));
    const e = ac.get(k) ?? { qty: 0, sen: 0 };
    e.qty += c.qty; e.sen += c.value_sen; ac.set(k, e);
  }
  const acTotal = [...ac.values()].reduce((a, e) => a + e.sen, 0);
  const acQty = [...ac.values()].reduce((a, e) => a + e.qty, 0);

  /* ── our side ──────────────────────────────────────────────────────────── */
  const lots = await sql`
    SELECT l.item_code, l.qty_remaining::numeric AS qty,
           coalesce(l.unit_cost_sen, 0)::bigint AS cost,
           l.source_doc_type, l.source_doc_no
      FROM scm.inventory_lots l
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0`;
  /* The consignment rule, copied from src/scm/lib/inventory-movements.ts:103 so
     the two answers cannot drift on the classification. */
  const isConsignment = (t, n) => {
    const ty = String(t ?? '').toUpperCase();
    if (ty === 'PC_RECEIVE' || ty === 'PC_RETURN' || ty === 'PURCHASE_CONSIGNMENT_NOTE') return true;
    return /(?:^|-)PCR-/i.test(String(n ?? ''));
  };

  const erp = new Map();
  let consign = { qty: 0, sen: 0, lots: 0 };
  let zeroCost = { qty: 0, lots: 0, codes: new Set() };
  for (const l of lots) {
    const q = Number(l.qty);
    const sen = Math.round(q * Number(l.cost));
    if (isConsignment(l.source_doc_type, l.source_doc_no)) {
      consign.qty += q; consign.sen += sen; consign.lots += 1;
      continue;
    }
    if (Number(l.cost) === 0) { zeroCost.qty += q; zeroCost.lots += 1; zeroCost.codes.add(l.item_code); }
    const k = foldKey(norm(l.item_code));
    const e = erp.get(k) ?? { qty: 0, sen: 0 };
    e.qty += q; e.sen += sen; erp.set(k, e);
  }
  const erpTotal = [...erp.values()].reduce((a, e) => a + e.sen, 0);
  const erpQty = [...erp.values()].reduce((a, e) => a + e.qty, 0);

  /* ── the headline, with every definitional line shown ─────────────────── */
  log('\n=== THE NUMBER THE BALANCE SHEET WILL CARRY ===');
  log(`  AutoCount, comparable stock          ${String(Math.round(acQty)).padStart(7)}u   ${rm(acTotal).padStart(16)}`);
  log(`  our system, comparable stock         ${String(Math.round(erpQty)).padStart(7)}u   ${rm(erpTotal).padStart(16)}`);
  log(`  DIFFERENCE (ours minus the book)     ${String(Math.round(erpQty - acQty)).padStart(7)}u   ${rm(erpTotal - acTotal).padStart(16)}`);
  log('');
  log('  set aside before comparing, each for a stated reason:');
  log(`    AutoCount SERVICE items — the owner's ruling, we do not carry them`);
  log(`        ${String(acService.cells).padStart(5)} cell(s)  ${String(Math.round(acService.qty)).padStart(6)}u   ${rm(acService.sen)}`);
  log(`    AutoCount cells at a NEGATIVE balance — the book disagreeing with itself`);
  log(`        ${String(acNegative.cells).padStart(5)} cell(s)  ${String(Math.round(acNegative.qty)).padStart(6)}u   ${rm(acNegative.sen)}`);
  log(`    our CONSIGNMENT stock — quantity yes, value no (owner rule 2026-07-25)`);
  log(`        ${String(consign.lots).padStart(5)} lot(s)   ${String(Math.round(consign.qty)).padStart(6)}u   ${rm(consign.sen)} of value not counted`);
  log(`    our lots still at ZERO cost — nothing prices them, the book included`);
  log(`        ${String(zeroCost.lots).padStart(5)} lot(s)   ${String(Math.round(zeroCost.qty)).padStart(6)}u   across ${zeroCost.codes.size} code(s)`);
  if (acUnmapped.codes.size) {
    log(`    AutoCount items with NO row in the binding sheet — they cannot be matched`);
    log(`        ${String(acUnmapped.codes.size).padStart(5)} code(s)  ${String(Math.round(acUnmapped.qty)).padStart(6)}u   ${rm(acUnmapped.sen)}`);
    log(`        ${[...acUnmapped.codes].slice(0, 8).join(', ')}${acUnmapped.codes.size > 8 ? ' …' : ''}`);
  }

  /* ── every product that moves the total ───────────────────────────────── */
  const keys = new Set([...ac.keys(), ...erp.keys()]);
  const rows = [];
  for (const k of keys) {
    const a = ac.get(k) ?? { qty: 0, sen: 0 };
    const e = erp.get(k) ?? { qty: 0, sen: 0 };
    const dSen = e.sen - a.sen;
    const dQty = e.qty - a.qty;
    if (dSen === 0 && Math.abs(dQty) < 0.0001) continue;
    rows.push({ k, aQty: a.qty, aSen: a.sen, eQty: e.qty, eSen: e.sen, dQty, dSen,
      sofa: isSofaKey(k) });
  }
  rows.sort((x, y) => Math.abs(y.dSen) - Math.abs(x.dSen));
  const onlyBook = rows.filter((r) => r.eQty === 0);
  const onlyOurs = rows.filter((r) => r.aQty === 0);

  log(`\n=== PRODUCTS THAT DIFFER: ${rows.length} of ${keys.size} ===`);
  log(`  the book has it and we do not: ${onlyBook.length}   we have it and the book does not: ${onlyOurs.length}`);
  log(`  (the owner's rule: what AutoCount does not have, we do not need)`);
  log('');
  log(`  ${'product'.padEnd(34)} ${'qty book vs ours'.padStart(19)} ${'book value'.padStart(14)} ${'our value'.padStart(14)} ${'difference'.padStart(14)}`);
  log('  ("pcs" marks a sofa: the book counts whole sofas and we count compartments,');
  log('   so only the VALUE of those two columns is comparable.)');
  for (const r of rows.slice(0, TOP)) {
    /* On a sofa the two quantities count different things — whole sofas in the
       book, compartments here — so the number is printed and marked, never
       subtracted. Only the VALUE is comparable, and value is what the balance
       sheet carries. */
    const q = r.sofa ? `${Math.round(r.aQty)} vs ${Math.round(r.eQty)} pcs` : `${Math.round(r.aQty)} vs ${Math.round(r.eQty)}`;
    log(`  ${r.k.slice(0, 34).padEnd(34)} ${q.padStart(19)} `
      + `${rm(r.aSen).padStart(14)} ${rm(r.eSen).padStart(14)} ${rm(r.dSen).padStart(14)}`);
  }
  if (rows.length > TOP) {
    const tail = rows.slice(TOP).reduce((a, r) => a + r.dSen, 0);
    log(`  … ${rows.length - TOP} more, together ${rm(tail)}`);
  }

  await sql.end();
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
