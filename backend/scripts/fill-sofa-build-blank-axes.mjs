#!/usr/bin/env node
/* fill-sofa-build-blank-axes — give a sofa piece that has NO colour (or no leg)
 * the colour its own sofa already carries, on NAMED documents only.
 *
 * WHY. docs/bugs/0896: every compartment the corrections applier ever ADDED went
 * in with `{seatHeight}` and nothing else, because its variants were built from
 * a row it did not have. The applier is fixed, and a full dry-run of it (run
 * 34845213476) named 11 documents still carrying such a piece. The owner,
 * 2026-09-14: 「有processing date的话就要找了」 (all 11 have one, read-only run
 * 34861112731), and 「找得到colour？」 - so the plan prints, per blank piece, the
 * value it would copy AND where it comes from, and a piece with nothing to copy
 * from is listed as CANNOT FIND rather than guessed.
 *
 * WHY NOT RE-RUN THE CORRECTIONS APPLIER FOR THIS. Its plan for these documents
 * is not a fill: it re-states item codes, names, unit price, total and
 * balance_sen on every piece, one of them (HC-SO-012929) would ADD a 1S from an
 * older entry, and HC-PO-010041 is refused as two sofas. A colour fill must
 * change the colour and nothing else, so it gets a tool that can only do that.
 *
 * WHERE A VALUE MAY COME FROM (sofa-build-axes.mjs is the rule):
 *   - the SAME SOFA's other pieces on the same document: rows sharing the
 *     account-book line key (linked_ac_dtlkey), when they carry exactly ONE
 *     fabric. A row with no line key may use the document's other sofa rows only
 *     when the WHOLE document carries exactly one fabric;
 *   - for a purchase line, also the sales-order line it is dedicated to
 *     (so_item_id) - that line's own value, or the value this run fills on it;
 *   - a sales-order line this run fills CARRIES the same values onto every
 *     purchase line dedicated to it that is blank ("carry to linked PO lines").
 *   When the available sources disagree it is CANNOT FIND, with both named.
 *
 * WHAT IT WRITES. Only keys that are blank on the row, inside `variants`, merged
 * `variants || patch`. The five fabric fields move together. SPECIALS are never
 * copied (they carry money). No item code, qty, price, total, balance, status or
 * date is written, and no receipt / delivery / invoice line: HC-PO-009630 is
 * RECEIVED and HC-SO-012913 DELIVERED, and the owner's instruction is to fill the
 * record and change nothing else.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN.
 *   CONFIRM           apply needs exactly "FILL THE SOFA'S OWN COLOUR", else exit 2.
 *   Each UPDATE is guarded on the row's variants being byte-identical to what the
 *   plan read (md5), so a row somebody edited since is skipped, never overwritten.
 *   VERIFY re-reads every written row on a FRESH connection and asserts the SHAPE:
 *   each patched key holds the planned value, every key the row had before is
 *   unchanged (specials included), no other key appeared, and every OTHER column
 *   of the row (to_jsonb minus variants/updated_at) is identical.
 * RE-RUN: convergent. A filled key is no longer blank, so a second run plans 0
 * writes for it; a CANNOT FIND piece is listed again, unchanged.
 *
 * Env: DATABASE_URL (required)  DOCS (required, comma-separated)
 *      MODE=plan|apply  CONFIRM  COMPANY_ID (default 1)
 */
import postgres from 'postgres';
import { FABRIC_FIELDS, sharedBuildAxes, fillFromBuild } from './lib/sofa-build-axes.mjs';

const CONFIRM_PHRASE = "FILL THE SOFA'S OWN COLOUR";
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS && m ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(2); }
if (!DOCS.length) { console.error('DOCS is required - this tool never runs company-wide.'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const newSql = () => postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const fabricOf = (v) => {
  if (!str(v?.fabricCode)) return null;
  const f = {};
  for (const k of FABRIC_FIELDS) if (str(v[k])) f[k] = str(v[k]);
  return f;
};

const sql = newSql();

async function soRows(doc) {
  return sql`
    SELECT i.id::text AS id, i.doc_no AS doc, i.line_no, i.item_code, i.linked_ac_dtlkey::text AS key,
           i.variants, md5(coalesce(i.variants::text, '')) AS vh, NULL::text AS so_item_id
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.doc_no = ${doc}
       AND lower(coalesce(i.item_group, '')) = 'sofa' AND coalesce(i.cancelled, false) = false
     ORDER BY i.line_no, i.id`;
}
async function poRows(doc) {
  return sql`
    SELECT i.id::text AS id, p.po_number AS doc, i.line_no, i.item_code, i.linked_ac_dtlkey::text AS key,
           i.variants, md5(coalesce(i.variants::text, '')) AS vh, i.so_item_id::text AS so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.po_number = ${doc}
       AND lower(coalesce(i.item_group, '')) = 'sofa'
     ORDER BY i.line_no NULLS LAST, i.id`;
}
const label = (r) => `${r.doc} ln ${r.line_no ?? '?'} ${r.item_code}`;

/** Candidate values from the same sofa's other rows on this document. */
function siblingSource(r, rows) {
  const mates = r.key ? rows.filter((x) => x.key === r.key && x.id !== r.id) : null;
  if (mates) {
    const s = sharedBuildAxes(mates);
    return { fabric: s.fabric, leg: s.legHeight, twoTone: s.twoTone,
      from: mates.filter((x) => fabricOf(x.variants)).map(label), legFrom: mates.filter((x) => str(x.variants?.legHeight)).map(label),
      how: `same sofa (book line ${r.key})` };
  }
  const others = rows.filter((x) => x.id !== r.id);
  const s = sharedBuildAxes(others);
  return { fabric: s.fabric, leg: s.legHeight, twoTone: s.twoTone,
    from: others.filter((x) => fabricOf(x.variants)).map(label), legFrom: others.filter((x) => str(x.variants?.legHeight)).map(label),
    how: 'no book line key - the document\'s other sofa rows, usable only because they carry one fabric' };
}

/** Choose one value among agreeing sources, or say why not. */
function choose(cands, pick) {
  const got = cands.filter((c) => pick(c) != null);
  const distinct = [...new Set(got.map((c) => stable(pick(c))))];
  if (!got.length) return { value: null, why: 'no source carries it' };
  if (distinct.length > 1) return { value: null, why: `sources disagree: ${got.map((c) => `${c.name} ${stable(pick(c))}`).join(' vs ')}` };
  return { value: pick(got[0]), sources: got.map((c) => c.name) };
}

const plan = [];            // { table, row, patch, sources }
const cannot = [];          // { doc, piece, axis, why }
const plannedSoVariants = new Map(); // so row id -> variants after this run's fill

function planRow(table, r, cands) {
  const v = r.variants ?? {};
  const needFabric = !str(v.fabricCode);
  const needLeg = !str(v.legHeight);
  if (!needFabric && !needLeg) return;
  const shared = { fabric: null, legHeight: null };
  const sources = [];
  const conflict = cands.find((x) => x.conflict);
  if (needFabric && conflict) {
    cannot.push({ doc: r.doc, piece: label(r), axis: 'colour', why: conflict.conflict });
  } else if (needFabric) {
    const c = choose(cands, (x) => x.fabric);
    if (c.value) { shared.fabric = c.value; sources.push(`colour <- ${c.sources.join(' + ')}`); }
    else cannot.push({ doc: r.doc, piece: label(r), axis: 'colour', why: c.why });
  }
  if (needLeg) {
    const c = choose(cands, (x) => x.leg);
    if (c.value) { shared.legHeight = c.value; sources.push(`leg <- ${c.sources.join(' + ')}`); }
    else cannot.push({ doc: r.doc, piece: label(r), axis: 'leg', why: c.why });
  }
  const { variants, filled } = fillFromBuild(v, shared);
  if (!filled.length) return;
  const patch = Object.fromEntries(filled.map((k) => [k, variants[k]]));
  plan.push({ table, row: r, patch, sources });
  return variants;
}

try {
  log(`MODE=${MODE}  company ${CO}  DOCS=${DOCS.join(',')}`);
  const soDocs = DOCS.filter((d) => /-SO-/.test(d));
  const poDocs = DOCS.filter((d) => /-PO-/.test(d));
  const other = DOCS.filter((d) => !soDocs.includes(d) && !poDocs.includes(d));
  for (const d of other) log(`  ${d}: not a sales or purchase order - skipped`);

  /* 1. Sales orders: the same sofa's other pieces. */
  for (const doc of soDocs) {
    const rows = await soRows(doc);
    if (!rows.length) { log(`  ${doc}: no sofa lines in company ${CO}`); continue; }
    for (const r of rows) {
      const s = siblingSource(r, rows);
      const cands = [];
      if (s.fabric || s.leg) cands.push({ name: `${s.how}: ${s.from.join(', ') || s.legFrom.join(', ')}`, fabric: s.fabric, leg: s.leg });
      if (s.twoTone) cands.push({ name: `${s.how}`, fabric: null, leg: null, conflict: `${s.how} carries TWO fabrics (${s.from.join(', ')}) - a two-tone build is not chosen between` });
      const after = planRow('scm.mfg_sales_order_items', r, cands);
      if (after) plannedSoVariants.set(r.id, after);
    }
  }

  /* 2. Carry: every purchase line dedicated to a sales line filled above. */
  const carried = new Set();
  if (plannedSoVariants.size) {
    const lines = await sql`
      SELECT i.id::text AS id, p.po_number AS doc, i.line_no, i.item_code, i.linked_ac_dtlkey::text AS key,
             i.variants, md5(coalesce(i.variants::text, '')) AS vh, i.so_item_id::text AS so_item_id, p.status::text AS status
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE p.company_id = ${CO} AND i.so_item_id = ANY(${[...plannedSoVariants.keys()]})`;
    for (const r of lines) {
      if (poDocs.includes(r.doc)) continue; // planned with its own document below
      const sv = plannedSoVariants.get(r.so_item_id);
      planRow('scm.purchase_order_items', r, [{ name: `carried from its sales-order line (${r.status} PO)`, fabric: fabricOf(sv), leg: str(sv?.legHeight) || null }]);
      carried.add(r.id);
    }
  }

  /* 3. Purchase orders: same sofa's other pieces, and the dedicated SO line. */
  for (const doc of poDocs) {
    const rows = await poRows(doc);
    if (!rows.length) { log(`  ${doc}: no sofa lines in company ${CO}`); continue; }
    const soIds = rows.map((r) => r.so_item_id).filter(Boolean);
    const soLines = soIds.length ? await sql`
      SELECT id::text AS id, doc_no AS doc, line_no, item_code, variants FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds})` : [];
    const soById = new Map(soLines.map((s) => [s.id, s]));
    for (const r of rows) {
      const s = siblingSource(r, rows);
      const cands = [];
      if (s.fabric || s.leg) cands.push({ name: `${s.how}: ${s.from.join(', ') || s.legFrom.join(', ')}`, fabric: s.fabric, leg: s.leg });
      if (s.twoTone) cands.push({ name: `${s.how}`, fabric: null, leg: null, conflict: `${s.how} carries TWO fabrics (${s.from.join(', ')}) - a two-tone build is not chosen between` });
      const so = r.so_item_id ? soById.get(r.so_item_id) : null;
      if (so) {
        const sv = plannedSoVariants.get(so.id) ?? so.variants;
        const name = `its sales-order line ${so.doc} ln ${so.line_no} ${so.item_code}${plannedSoVariants.has(so.id) ? ' (as this run fills it)' : ''}`;
        if (fabricOf(sv) || str(sv?.legHeight)) cands.push({ name, fabric: fabricOf(sv), leg: str(sv?.legHeight) || null });
      }
      planRow('scm.purchase_order_items', r, cands);
    }
  }

  /* The plan, per document. */
  const byDoc = new Map();
  for (const p of plan) { if (!byDoc.has(p.row.doc)) byDoc.set(p.row.doc, []); byDoc.get(p.row.doc).push(p); }
  log('');
  log(`=== WOULD FILL: ${plan.length} row(s) on ${byDoc.size} document(s) ===`);
  for (const [doc, ps] of byDoc) {
    log(`  ${doc}`);
    for (const p of ps) {
      log(`    ${label(p.row)}  ${carried.has(p.row.id) ? '[carry] ' : ''}${JSON.stringify(p.patch)}`);
      for (const s of p.sources) log(`        ${s}`);
    }
  }
  log('');
  log(`=== CANNOT FIND: ${cannot.length} ===`);
  for (const c of cannot) log(`  ${c.piece}  ${c.axis}: ${c.why}`);
  for (const d of DOCS) if (!byDoc.has(d) && !cannot.some((c) => c.doc === d)) log(`  ${d}: nothing blank - no row needs a colour or a leg`);

  if (!APPLY) { log(''); log('PLAN ONLY - nothing was written.'); await sql.end(); process.exit(0); }

  /* APPLY: one UPDATE per row, guarded on the variants the plan read. */
  const before = new Map();
  for (const p of plan) {
    const [r] = await sql.unsafe(`SELECT to_jsonb(t) AS j FROM ${p.table} t WHERE id = $1`, [p.row.id]);
    before.set(p.row.id, r?.j ?? null);
  }
  const written = [];
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await tx.unsafe(
        `UPDATE ${p.table} SET variants = coalesce(variants, '{}'::jsonb) || $1::text::jsonb
          WHERE id = $2 AND md5(coalesce(variants::text, '')) = $3`,
        [JSON.stringify(p.patch), p.row.id, p.row.vh]);
      if (Number(res.count) === 1) written.push(p);
      else log(`  SKIPPED ${label(p.row)}: its variants changed since the plan read them`);
    }
  });
  await sql.end();
  log(`written ${written.length} of ${plan.length}`);

  /* VERIFY on a fresh connection: the SHAPE, not a count. */
  const v = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  let bad = 0;
  for (const p of written) {
    const [r] = await v.unsafe(`SELECT to_jsonb(t) AS j FROM ${p.table} t WHERE id = $1`, [p.row.id]);
    const was = before.get(p.row.id) ?? {};
    const now = r?.j ?? {};
    const problems = [];
    const vb = was.variants ?? {};
    const va = now.variants ?? {};
    for (const [k, val] of Object.entries(p.patch)) if (va[k] !== val) problems.push(`${k} is ${JSON.stringify(va[k])}, planned ${JSON.stringify(val)}`);
    for (const k of Object.keys(vb)) if (!(k in p.patch) && stable(vb[k]) !== stable(va[k])) problems.push(`variants.${k} moved`);
    for (const k of Object.keys(va)) if (!(k in vb) && !(k in p.patch)) problems.push(`variants.${k} appeared`);
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (k === 'variants' || k === 'updated_at') continue;
      if (stable(was[k]) !== stable(now[k])) problems.push(`column ${k} moved ${stable(was[k])} -> ${stable(now[k])}`);
    }
    if (problems.length) { bad++; log(`  FAIL ${label(p.row)}: ${problems.join('; ')}`); }
    else log(`  OK   ${label(p.row)}  ${JSON.stringify(Object.fromEntries(Object.keys(p.patch).map((k) => [k, va[k]])))}`);
  }
  await v.end();
  if (bad) { console.error(`VERIFY FAILED on ${bad} row(s)`); process.exit(1); }
  log(`VERIFY OK - ${written.length} row(s): each planned key holds its value, no other key or column moved`);
} catch (e) {
  console.error('FAIL', e);
  try { await sql.end({ timeout: 3 }); } catch { /* already closed */ }
  process.exit(1);
}
