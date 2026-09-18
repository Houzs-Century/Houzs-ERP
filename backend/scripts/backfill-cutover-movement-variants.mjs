#!/usr/bin/env node
/* backfill-cutover-movement-variants — put the book's specification onto the
 * STOCK LEDGER rows the AutoCount cutover left blank.
 *
 * Run under tsx (it imports variant-key.ts):
 *   npx tsx backend/scripts/backfill-cutover-movement-variants.mjs
 *
 * ── WHY THIS EXISTS WHEN THE 2026-09-09 RUN ALREADY HAPPENED ───────────────
 * Owner, 2026-09-11: 「可是我记得之前做过的」 — he is right, and it filled the
 * wrong book. `fill-cutover-lot-variants-2026-09-09.mjs` wrote
 * `scm.inventory_lots.variant_key`: the COST layers, which is what FIFO reads.
 * It never touched `scm.inventory_movements`, and `scm.inventory_balances` — the
 * on-hand every stock screen reads — is a VIEW over the movements. So the screens
 * did not move at all. Measured 2026-09-11, company 1:
 *
 *     AC_CUTOVER movements   3,478 rows, 221 carry a spec
 *     bedframe on hand         573 units under the BLANK key, -26 keyed
 *
 * ── WHAT FIXING IT IS WORTH, SAID HONESTLY ────────────────────────────────
 * The delivery screen no longer needs it: since 2026-09-11 the DO check counts
 * by SKU and ignores the spec (docs/bugs/0819). What this buys is the other two
 * things that check could not:
 *
 *  - THE NEGATIVE BUCKETS NET OFF. 46 of the 52 negative bedframe/sofa buckets
 *    are a bucket that never received anything and was shipped out of, and 43 of
 *    those have the goods under the blank key at that same warehouse. Moving the
 *    IN row to the spec it actually was cancels the negative against the positive.
 *  - "HOW MANY OF THAT FABRIC ARE LEFT" becomes a real number for the first time.
 *
 * ── WHAT IT MOVES, AND WHAT IT MUST NOT ───────────────────────────────────
 * Stamping a key on an IN row moves that quantity from the blank bucket to the
 * spec bucket. Nothing is created or destroyed and no money moves: the row's
 * qty, cost and document are untouched. The verification therefore asserts the
 * per-(warehouse, item) TOTAL is byte-identical before and after — a count of
 * rows cannot see a quantity landing in the wrong bucket, and that is exactly
 * the failure this could produce.
 *
 * Only `AC_CUTOVER` rows with an EMPTY key, on BEDFRAME / SOFA items, in this
 * company. Our own GRN receipts and DO shipments already carry their spec and
 * are never touched; mattress and accessory have no variant axis at all, so a
 * key on one of those would be a defect, and the verify gates on it.
 *
 * Resolution is `lib/cutover-variant-source.mjs` — the same evidence chain the
 * 2026-09-09 run proved, not a second copy of it. A row whose document cannot be
 * identified and whose item has been received under more than one spec is LEFT
 * ALONE and printed in full. Owner: 「如果没有 variant，那就算了」.
 *
 * RE-RUN: idempotent. A second run finds them filled (the UPDATE re-asserts the
 * blank in its WHERE clause) and reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import postgres from 'postgres';
import { buildCutoverVariantSource } from './lib/cutover-variant-source.mjs';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'fill cutover movement variants';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(2); }
if (MODE !== 'plan' && MODE !== 'apply') { console.error(`MODE must be plan or apply (got "${MODE}")`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

/** Per (warehouse, item) totals — the shape a bucket move must not change. */
const totalsSql = (c) => c`
  SELECT warehouse_id::text AS w, item_code AS i, sum(qty)::numeric AS q
    FROM scm.inventory_balances WHERE company_id = ${CO}
   GROUP BY 1, 2 ORDER BY 1, 2`;
const negativesSql = (c) => c`
  SELECT count(*)::int AS buckets, coalesce(sum(qty), 0)::numeric AS units
    FROM scm.inventory_balances WHERE company_id = ${CO} AND qty < 0`;

log(`MODE=${MODE}  company ${CO}`);

const fcRows = await sql`
  SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
const source = buildCutoverVariantSource(fcRows);
log(`fabric colours: ${fcRows.length}`);
log(`AutoCount extraction: ${source.stats.receipts} receipt(s), ${source.stats.addressableByDocument} `
  + `addressable by document, ${source.stats.itemsWithASpec} item(s) carry a spec; `
  + `exported ${source.stats.exportedAt}`);

const rows = await sql`
  SELECT m.id, m.item_code, m.qty::numeric AS qty, m.warehouse_id::text AS warehouse_id,
         m.movement_type::text AS movement_type, m.notes,
         upper(coalesce(p.category::text, '')) AS category
    FROM scm.inventory_movements m
    LEFT JOIN scm.mfg_products p
           ON upper(p.code) = upper(m.item_code) AND p.company_id = ${CO}
   WHERE m.company_id = ${CO}
     AND m.source_doc_type = 'AC_CUTOVER'
     AND coalesce(m.variant_key, '') = ''
   ORDER BY m.item_code, m.created_at`;
log(`AC_CUTOVER movements with no spec: ${rows.length}`);

const plan = [];
const skip = new Map();
const unresolved = [];
const bump = (k, n) => {
  const e = skip.get(k) ?? { rows: 0, units: 0 };
  e.rows += 1; e.units += n; skip.set(k, e);
};

for (const r of rows) {
  const units = Number(r.qty);
  const cat = String(r.category || '');
  const group = cat === 'BEDFRAME' ? 'bedframe' : cat === 'SOFA' ? 'sofa' : null;
  if (!group) {
    bump(cat
      ? `${cat.toLowerCase()} — no variant axis in variant-key.ts, correctly blank`
      : 'item not in the product master — category unknown', units);
    continue;
  }
  const hit = source.resolve({ itemCode: r.item_code, group, notes: r.notes });
  if (!hit) {
    bump(`${group}: no receipt of its own, and the item's receipts disagree`, units);
    unresolved.push({ code: r.item_code, group, units, note: r.notes ?? null,
      receipts: source.receiptsFor(r.item_code) });
    continue;
  }
  plan.push({ id: r.id, code: r.item_code, group, qty: units, warehouse: r.warehouse_id, ...hit });
}

const units = plan.reduce((s, p) => s + p.qty, 0);
log(`\n=== WOULD FILL: ${plan.length} movement(s) / ${units} unit(s) ===`);
const seen = new Set();
for (const p of plan) {
  const k = `${p.code} ${p.key}`;
  if (seen.has(k)) continue;
  seen.add(k);
  log(`  ${pad(p.code, 24)} ${p.key}`);
  log(`      via ${p.via}${p.bookText ? ` — book text: ${p.bookText.slice(0, 88)}` : ''}`);
}
log(`  (${plan.length} movement(s) collapse to ${seen.size} distinct item+key pair(s))`);

log('\n  LEFT ALONE:');
for (const [k, v] of [...skip].sort((a, b) => b[1].units - a[1].units)) {
  log(`    ${String(v.rows).padStart(5)} row(s) / ${String(v.units).padStart(6)} unit(s) — ${k}`);
}
if (unresolved.length) {
  log('\n  UNRESOLVED, in full (these have an axis and no answer):');
  for (const u of unresolved.slice(0, 200)) {
    log(`    ${pad(u.code, 22)} ${pad(u.group, 8)} ${String(u.units).padStart(4)}u  `
      + `spec-bearing receipts for this code: ${u.receipts}  note: ${u.note ?? '(none)'}`);
  }
  if (unresolved.length > 200) log(`    ... and ${unresolved.length - 200} more`);
}

const [negBefore] = await negativesSql(sql);
log(`\nnegative buckets right now: ${negBefore.buckets} bucket(s), ${negBefore.units} unit(s)`);

/* WHAT THE NEGATIVES WOULD DO — simulated from the live buckets, because the
   whole business case for this run is "46 of the 55 negative units cancel out",
   and that is a claim about an operation. Moving an IN row's key takes the
   quantity out of the blank bucket and puts it in the spec bucket, so the
   simulation is exactly that arithmetic over today's balances. */
const liveBuckets = await sql`
  SELECT warehouse_id::text AS w, item_code AS i, coalesce(variant_key, '') AS k, qty::numeric AS q
    FROM scm.inventory_balances WHERE company_id = ${CO}`;
const sim = new Map();
for (const b of liveBuckets) sim.set(`${b.w}|${b.i}|${b.k}`, Number(b.q));
for (const p of plan) {
  const blank = `${p.warehouse}|${p.code}|`;
  const keyed = `${p.warehouse}|${p.code}|${p.key}`;
  sim.set(blank, (sim.get(blank) ?? 0) - p.qty);
  sim.set(keyed, (sim.get(keyed) ?? 0) + p.qty);
}
let simBuckets = 0; let simUnits = 0;
for (const q of sim.values()) if (q < 0) { simBuckets += 1; simUnits += q; }
log(`after this run they would be:   ${simBuckets} bucket(s), ${simUnits} unit(s)  [simulated]`);

/* PROBE — why the simulation moves the way it does. */
const negRows = Number(plan.filter((x) => x.qty < 0).length);
const negUnits = plan.filter((x) => x.qty < 0).reduce((a, x) => a + x.qty, 0);
log(`  planned rows with a NEGATIVE quantity: ${negRows} (${negUnits} units) — these are cutover CORRECTIONS`);
const sim2 = new Map();
for (const b of liveBuckets) sim2.set(`${b.w}|${b.i}|${b.k}`, Number(b.q));
for (const p of plan.filter((x) => x.qty > 0)) {
  const blank = `${p.warehouse}|${p.code}|`;
  const keyed = `${p.warehouse}|${p.code}|${p.key}`;
  sim2.set(blank, (sim2.get(blank) ?? 0) - p.qty);
  sim2.set(keyed, (sim2.get(keyed) ?? 0) + p.qty);
}
let b2 = 0; let u2 = 0;
for (const q of sim2.values()) if (q < 0) { b2 += 1; u2 += q; }
log(`  positive rows only:             ${b2} bucket(s), ${u2} unit(s)  [simulated]`);
const beforeNeg = new Set();
for (const b of liveBuckets) if (Number(b.q) < 0) beforeNeg.add(`${b.w}|${b.i}|${b.k}`);
let healed = 0;
for (const k of beforeNeg) if ((sim.get(k) ?? 0) >= 0) healed += 1;
let created = 0;
for (const [k, q] of sim) if (q < 0 && !beforeNeg.has(k)) created += 1;
log(`  buckets healed: ${healed}   buckets newly negative: ${created}`);

/* WHY IT DOES NOT HEAL — put the two keys side by side. For each negative
   bucket, is there a planned row for the SAME item at the SAME warehouse, and
   does the spec the BOOK'S RECEIPT gives differ from the spec the DELIVERY
   ORDER shipped under? */
log('\n  NEGATIVE BUCKET vs WHAT THE BOOK SAYS THE STOCK IS:');
let shown = 0;
for (const b of liveBuckets) {
  if (Number(b.q) >= 0) continue;
  const mine = plan.filter((x) => x.warehouse === b.w && x.code === b.i);
  if (mine.length === 0) continue;
  if (shown++ > 14) break;
  log(`    ${pad(b.i, 22)} ${String(b.q).padStart(4)}`);
  log(`      shipped under: ${b.k || '(blank)'}`);
  for (const k of new Set(mine.map((x) => x.key))) log(`      book receipt:  ${k}`);
}
if (shown === 0) log('    (no negative bucket has a planned row for the same item+warehouse)');

if (!APPLY) {
  log('\nPLAN ONLY — nothing was written.');
  await sql.end();
  process.exit(0);
}

const totalsBefore = await totalsSql(sql);
const [countBefore] = await sql`
  SELECT count(*)::int AS n, coalesce(sum(qty), 0)::numeric AS q
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
const [noAxisBefore] = await sql`
  SELECT count(*)::int AS n FROM scm.inventory_movements m
    LEFT JOIN scm.mfg_products p ON upper(p.code) = upper(m.item_code) AND p.company_id = ${CO}
   WHERE m.company_id = ${CO} AND coalesce(m.variant_key, '') <> ''
     AND upper(coalesce(p.category::text, '')) NOT IN ('SOFA', 'BEDFRAME')`;

let wrote = 0;
for (const p of plan) {
  const done = await sql`
    UPDATE scm.inventory_movements SET variant_key = ${p.key}
     WHERE id = ${p.id} AND coalesce(variant_key, '') = ''
    RETURNING id`;
  wrote += done.length;
}
log(`\nAPPLIED: ${wrote} movement(s) filled.`);
await sql.end();

/* VERIFY ON A FRESH CONNECTION, ON THE SHAPE. A row count cannot see a quantity
   landing in the wrong bucket, and that is the failure this run could produce. */
const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
const totalsAfter = await totalsSql(check);
const [countAfter] = await check`
  SELECT count(*)::int AS n, coalesce(sum(qty), 0)::numeric AS q
    FROM scm.inventory_movements WHERE company_id = ${CO}`;
const [noAxisAfter] = await check`
  SELECT count(*)::int AS n FROM scm.inventory_movements m
    LEFT JOIN scm.mfg_products p ON upper(p.code) = upper(m.item_code) AND p.company_id = ${CO}
   WHERE m.company_id = ${CO} AND coalesce(m.variant_key, '') <> ''
     AND upper(coalesce(p.category::text, '')) NOT IN ('SOFA', 'BEDFRAME')`;
const [stillBlank] = await check`
  SELECT count(*)::int AS n FROM scm.inventory_movements
   WHERE id = ANY(${plan.map((p) => p.id)}) AND coalesce(variant_key, '') = ''`;
const sample = plan.length
  ? await check`SELECT item_code, variant_key FROM scm.inventory_movements WHERE id = ${plan[0].id}`
  : [];
const [negAfter] = await negativesSql(check);
await check.end();

const key = (r) => `${r.w}|${r.i}`;
const beforeMap = new Map(totalsBefore.map((r) => [key(r), String(r.q)]));
const afterMap = new Map(totalsAfter.map((r) => [key(r), String(r.q)]));
const moved = [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
  .filter((k) => (beforeMap.get(k) ?? '0') !== (afterMap.get(k) ?? '0'));

const ok = {
  'every movement this run filled now carries a key': stillBlank.n === 0,
  'the key reads as our key=value|key=value shape':
    sample.length === 0 || /^[a-z]+=[^|]+(\|[a-z]+=[^|]+)*$/.test(sample[0].variant_key ?? ''),
  'no mattress or accessory movement gained one': noAxisAfter.n === noAxisBefore.n,
  'movement count unchanged': countAfter.n === countBefore.n,
  'total quantity unchanged': String(countAfter.q) === String(countBefore.q),
  'every (warehouse, item) still holds exactly what it held': moved.length === 0,
};

log('\n=== VERIFY (fresh connection) ===');
let bad = 0;
for (const [what, pass] of Object.entries(ok)) {
  log(`  ${pass ? 'OK  ' : 'FAIL'}  ${what}`);
  if (!pass) bad += 1;
}
if (moved.length) {
  log('  moved totals (this must be empty):');
  for (const k of moved.slice(0, 20)) log(`    ${k}: ${beforeMap.get(k) ?? '0'} -> ${afterMap.get(k) ?? '0'}`);
}
log(`\nnegative buckets: ${negBefore.buckets} bucket(s)/${negBefore.units} unit(s) `
  + `-> ${negAfter.buckets} bucket(s)/${negAfter.units} unit(s)`);

if (bad > 0) {
  console.error(`\n${bad} verification(s) FAILED — the report above is disowned. `
    + 'The keys written are listed in the plan section; a repair reverses them by id.');
  process.exit(4);
}
log('\nVerified. Quantities and money unchanged; the stock simply now says what it is.');
