// Read-only: for company-1 hard-bound DO lines, did the lot that costed the line
// come from the line's bound purchase order?
//
// WHY. Company 1 binds a bedframe / sofa / fabric accessory / dining / (SP)
// mattress sales line to the PO raised for it (isHardBoundLine,
// src/scm/lib/so-stock-allocation.ts), and readiness lights such a line only
// through that PO's received_qty. COGS does not follow the binding: a non-sofa DO
// OUT carries no batch_no (deductInventoryForDo, delivery-orders-mfg.ts), so the
// FIFO trigger and fn_reconcile_uncosted_out cost it from the oldest open lot of
// the same warehouse + item + variant_key, whatever PO that lot came from. The
// cutover no-spec repair of 2026-11-10 (run 42827135058) costed 37 DO OUTs that
// way from AutoCount cutover layers. This check shows, per line, which PO the
// costing lot belongs to and whether that is the bound PO.
//
// SECTIONS
//   A. Lines costed by the repair: DO OUTs that consumed a lot opened by an
//      ADJUSTMENT whose source_doc_no starts with REF (default CUTOVER-NOSPEC-),
//      plus every OUT of the DOs named in DO_NOS. Per line: DO, item, warehouse,
//      bound PO(s) and GRN(s), the costing lot's source (for a repair lot, the
//      cutover layer it was moved from), the PO that lot belongs to, the verdict
//      and the ratio actual / expected unit cost. Never an amount.
//   B. CENSUS=1: the same verdict over every company-1 DO OUT since CUTOVER,
//      counts only — how often FIFO already costs a hard-bound line from its
//      own PO.
//   C. Negative buckets after CUTOVER split by hard-bound vs pooled item, with the
//      uncosted OUT units in each: which negatives can change readiness at all.
//
// Expected unit cost = the bound PO's own GRN lots (recost.ts keeps them at the
// PI price), else the cutover layers relayered from the bound PO's AutoCount
// receipt (a migrated GRN is numbered HC-<AC GR>[-<AC PO>]; linked_ac_docno holds
// the AC PO, not the GR), else the MYR PO line price.
//
// PUBLIC LOG: document numbers, item codes, warehouse codes, quantities, verdicts
// and percentages only. No cost, amount, customer or phone.
//
//   Actions -> "Run a backend script on production": script
//   check-hard-bound-cost-vs-lot.mjs, mode plan, env e.g.
//   COMPANY_ID=1;REF=CUTOVER-NOSPEC-2026-11-10;CENSUS=1;DO_NOS=HC-DO-2609-204,HC-DO-2610-001
//
// SELECTs only, in one READ ONLY transaction; every query names company_id.
// Exits 0 for every real answer. Only a missing DATABASE_URL, an unreachable
// database or a query error exits non-zero.
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

import { isHardBoundLine } from '../src/scm/lib/so-stock-allocation.ts';
import { DEFAULT_REF_PREFIX, VERDICTS, tally, parseDocNos } from './lib/hard-bound-cost-check.mjs';
import { analyseHardBoundOuts, chunkList } from './lib/hard-bound-cost-analyse.mjs';
import { DEFAULT_CUTOVER, isNegativeAfterCutover, intEnv } from './lib/variant-key-drift.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.'); process.exit(1); }

const CO = Number.parseInt(process.env.COMPANY_ID || '1', 10);
const REF = /^[A-Z0-9-]+$/.test(process.env.REF ?? '') ? process.env.REF : DEFAULT_REF_PREFIX;
const DO_NOS = parseDocNos(process.env.DO_NOS);
const CENSUS = process.env.CENSUS === '1';
const CUTOVER = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CUTOVER ?? '') ? process.env.CUTOVER : DEFAULT_CUTOVER;
const LIMIT = intEnv(process.env.LIMIT, 40, 500);
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const chunks = (arr) => chunkList(arr);
const analyse = (sql, movementIds) => analyseHardBoundOuts(sql, CO, movementIds);

function printRows(rows) {
  for (const r of rows.slice(0, LIMIT)) {
    console.log(`  ${r.repair ? '[repair] ' : ''}${r.doNo} | ${r.itemCode} @ ${r.wh ?? '-'} | vk "${r.vk}" | qty ${r.qty} costed ${r.costedQty} | ${r.group}${r.hardBound ? ' BOUND' : ''}`);
    console.log(`      bound PO ${r.boundPoNos.join(', ') || '-'} | GRN ${r.boundGrns.join(', ') || '-'}`);
    for (const c of r.costing) console.log(`      lot: ${c.qty} from ${c.src} -> PO ${c.pos.join(', ') || '-'}${c.zero ? ' [lot at zero]' : ''}`);
    console.log(`      => ${r.verdict}; ratio actual/expected ${r.ratio} (${r.expSource})${r.same === null ? '' : r.same ? ' same cost' : ' DIFFERENT cost'}`);
  }
  if (rows.length > LIMIT) console.log(`  ... ${rows.length - LIMIT} more (raise LIMIT)`);
}

function summary(label, rows) {
  notice(`${label}: ${rows.length} DO OUT row(s)`);
  for (const [v, desc] of VERDICTS) {
    const n = rows.filter((r) => r.verdict === v).length;
    if (n) console.log(`    ${String(n).padStart(6)}  ${v} — ${desc}`);
  }
  const priced = rows.filter((r) => r.hardBound && r.same !== null);
  const n = (f) => String(rows.filter(f).length);
  console.log(`    hard-bound rows with a ratio: ${String(priced.length)}; ratio 100% ${String(priced.filter((r) => r.same).length)}; ratio not 100% ${String(priced.filter((r) => !r.same).length)}`);
  console.log(`    hard-bound rows whose every costing lot is at zero: ${n((r) => r.hardBound && r.allZero)}; pooled rows the same: ${n((r) => !r.hardBound && r.allZero)}`);
  for (const v of ['match', 'mismatch', 'partial']) {
    const vr = priced.filter((r) => r.verdict === v);
    console.log(`    ${v}: ratio 100% ${String(vr.filter((r) => r.same).length)}, not 100% ${String(vr.filter((r) => !r.same).length)}`);
  }
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
let failed = false;
try {
  await pg.begin('read only', async (sql) => {
    notice(`hard-bound cost vs lot: company ${CO}, REF ${REF}*, DO_NOS ${DO_NOS.length}, CENSUS ${CENSUS ? 'on' : 'off'}, cutover ${CUTOVER}`);

    console.log('\n-- A. DO OUTs costed from repair lots, and DO_NOS --');
    const fromRef = (await sql`
      SELECT DISTINCT c.movement_id::text AS id
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_lots l ON l.id = c.lot_id AND l.company_id = ${CO}
       WHERE l.source_doc_type = 'ADJUSTMENT' AND l.source_doc_no LIKE ${`${REF}%`} AND c.source_doc_type = 'DO'`).map((r) => r.id);
    const fromDos = DO_NOS.length === 0 ? [] : (await sql`
      SELECT m.id::text AS id FROM scm.inventory_movements m
        JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
       WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND d.do_number = ANY(${DO_NOS})`).map((r) => r.id);
    notice(`  ${fromRef.length} OUT(s) still consume a ${REF}* lot; ${fromDos.length} OUT(s) on the ${DO_NOS.length} named DO(s)`);
    const refSet = new Set(fromRef);
    const rowsA = (await analyse(sql, [...new Set([...fromRef, ...fromDos])])).map((r) => ({ ...r, repair: refSet.has(r.id) }));
    rowsA.sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true }) || a.itemCode.localeCompare(b.itemCode));
    summary('A', rowsA);
    summary('A, repair-costed rows only', rowsA.filter((r) => r.repair));
    console.log(`  distinct DOs: ${new Set(rowsA.map((r) => r.doNo)).size} — ${[...new Set(rowsA.map((r) => r.doNo))].join(', ') || '-'}`);
    printRows(rowsA);

    if (CENSUS) {
      console.log(`\n-- B. census: every company-${CO} DO OUT since ${CUTOVER} --`);
      const ids = (await sql`
        SELECT m.id::text AS id FROM scm.inventory_movements m
          JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
         WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.created_at >= ${CUTOVER}
           AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'`).map((r) => r.id);
      const rowsB = [];
      for (const c of chunks(ids)) rowsB.push(...await analyse(sql, c));
      summary('B', rowsB);
      console.log('  hard-bound rows by group and verdict:');
      for (const [k, n] of tally(rowsB.filter((r) => r.hardBound), (r) => `${String(r.group).toLowerCase()} / ${r.verdict}`)) console.log(`    ${String(n).padStart(6)}  ${k}`);
      console.log('  mismatch / partial examples:');
      printRows(rowsB.filter((r) => r.verdict === 'mismatch' || r.verdict === 'partial').slice(0, Math.min(LIMIT, 15)));
    }

    console.log(`\n-- C. negative buckets after ${CUTOVER}: hard-bound vs pooled --`);
    const buckets = await sql`
      WITH mv AS (
        SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
               SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
               MAX(created_at) FILTER (WHERE movement_type = 'OUT') AS last_out
          FROM scm.inventory_movements WHERE company_id = ${CO} GROUP BY 1, 2, 3),
      lt AS (
        SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
          FROM scm.inventory_lots WHERE company_id = ${CO} GROUP BY 1, 2, 3)
      SELECT mv.item_code AS "itemCode", mv.warehouse_id::text AS "warehouseId", mv.vk,
             mv.net AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_out AS "lastOutAt"
        FROM mv LEFT JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk`;
    const negative = buckets.filter((b) => isNegativeAfterCutover(b, CUTOVER));
    const codes = [...new Set(negative.map((b) => b.itemCode))];
    const groupOf = new Map((codes.length === 0 ? [] : await sql`
      SELECT i.item_code AS "itemCode", mode() WITHIN GROUP (ORDER BY i.item_group) AS "itemGroup"
        FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
       WHERE d.company_id = ${CO} AND i.item_code = ANY(${codes}) GROUP BY 1`).map((r) => [r.itemCode, r.itemGroup]));
    const unc = codes.length === 0 ? [] : await sql`
      SELECT m.item_code AS "itemCode", m.warehouse_id::text AS "warehouseId", COALESCE(m.variant_key, '') AS vk,
             SUM(ABS(m.qty) - COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0))::int AS short
        FROM scm.inventory_movements m
       WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.item_code = ANY(${codes})
       GROUP BY 1, 2, 3`;
    const shortOf = new Map(unc.map((u) => [`${u.itemCode}\u0001${u.warehouseId}\u0001${u.vk}`, Number(u.short)]));
    const classed = negative.map((b) => ({
      ...b, group: String(groupOf.get(b.itemCode) ?? '(no DO line)').toLowerCase(),
      hardBound: isHardBoundLine(groupOf.get(b.itemCode) ?? null, b.itemCode),
      short: Math.max(0, shortOf.get(`${b.itemCode}\u0001${b.warehouseId}\u0001${b.vk}`) ?? 0),
    }));
    const hb = classed.filter((b) => b.hardBound);
    notice(`  ${negative.length} negative bucket(s): ${hb.length} on hard-bound items (readiness reads the bound PO, not this bucket), ${negative.length - hb.length} on pooled items (readiness reads this bucket)`);
    console.log(`  uncosted DO OUT units: hard-bound ${hb.reduce((s, b) => s + b.short, 0)}, pooled ${classed.filter((b) => !b.hardBound).reduce((s, b) => s + b.short, 0)}`);
    for (const [k, n] of tally(classed, (b) => `${b.hardBound ? 'BOUND ' : 'pooled'} ${b.group}`)) console.log(`    ${String(n).padStart(6)}  ${k}`);
  });
} catch (e) {
  failed = true;
  console.error(`query failed: ${e.message}`);
} finally {
  await pg.end({ timeout: 5 });
}
if (failed) process.exit(1);
