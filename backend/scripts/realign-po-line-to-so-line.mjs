/* Put a purchase-order line back where an approved sales-order amendment should
   have left it: re-derived from the sales-order line it is linked to.

   ── WHY A LINE CAN BE LEFT BEHIND ──────────────────────────────────────────
   Confirming the PO follow-up of a sales-order amendment runs `reviseBoundPo`,
   which re-derives every bound PO line from its (already revised) SO line. Until
   PR #3629 (merged 2026-09-11 05:05Z, docs/bugs/0808) that re-derive never wrote
   `item_code` or `material_name`, and until docs/bugs/0887 (2026-09-14) never
   `supplier_sku`; until this script's PR it never wrote `description`. A follow-up
   confirmed before those fixes left the PO ordering the OLD item under a new
   revision number. Live case: HC-SO-013346/A3 changed line 2 SQUARE PILLOW ->
   AMN-SOFA PILLOW; HC-PO-010086/A1 was confirmed 2026-09-10 08:02Z and its pillow
   line still read SQUARE PILLOW — which the 2026-09-14 Sofa Accessory move then
   filed under fabric_accessory, because it keys on the item code.

   ── WHAT IT WRITES ─────────────────────────────────────────────────────────
   On ONE named live PO line, linked (so_item_id) to a live SO line of the same
   company whose item code differs: the patch `rederivePoLineFromSoLine`
   (src/scm/lib/po-line-rederive.ts) returns — the SAME function reviseBoundPo
   runs, read through lib/pgrest-shim.mjs behind a read-only guard, so the code,
   name, description, supplier code, category, variants, Description 2, cost,
   warehouse, date and photos are what the amendment confirm writes today. If the
   line total moves, the PO header subtotal/total move by the same amount. One
   entity_audit_log row (source 'repair'). It does NOT bump the PO revision, move
   so_item_id, or enqueue anything for AutoCount.

   LIST (no PO given): read-only census of every live company PO line whose item
   code differs from its linked SO line's — the population this can realign.

   SAFETY (release discipline, CLAUDE.md):
     MODE=plan (default) runs the write inside ONE transaction and ROLLS BACK.
     MODE=apply additionally requires CONFIRM="REALIGN THIS PO LINE".
     PO + LINE + EXPECT_CODE are required to plan a write. EXPECT_CODE must equal
     the linked SO line's item code, so a line linked somewhere unexpected refuses.
     Refuses a received line (stock is already booked under the old code), a
     cancelled PO or SO line, a missing / cross-company link, an ambiguous LINE.
     The UPDATE re-asserts the planned-on facts (code, qty, link, nothing received).
   VERIFY: re-reads on a FRESH connection and asserts the SHAPE: each written
   column reads back equal to the plan, variants is a jsonb object, so_item_id is
   unchanged, the line's code now equals its SO line's, and the header subtotal
   equals the sum of its lines' totals whenever it did before.

   RE-RUN: inert. A realigned line's code equals its SO line's, so the plan says
   "already aligned" and writes nothing.

   USAGE (tsx — imports the canonical derivation from src/):
     DATABASE_URL=... npx tsx scripts/realign-po-line-to-so-line.mjs            # LIST
     DATABASE_URL=... PO=HC-PO-010086 LINE="SQUARE PILLOW" EXPECT_CODE="AMN-SOFA PILLOW" \
       npx tsx scripts/realign-po-line-to-so-line.mjs
     ... MODE=apply CONFIRM="REALIGN THIS PO LINE" ...

   Env: DATABASE_URL  PO  LINE (line id or its current item code)  EXPECT_CODE
        MODE=plan|apply  CONFIRM  COMPANY (default 1)
        READ_ONLY=1 (plan only: print the derivation, never open the transaction) */

import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const GH = !!process.env.GITHUB_ACTIONS;
const note = (m) => console.log(GH ? `::notice::${m}` : m);
const bad = (m) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);
const say = (m = '') => console.log(m);

if (!DSN) { bad('DATABASE_URL is not set'); process.exit(1); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REALIGN THIS PO LINE';
const CO = Number(process.env.COMPANY || 1);
const PO = String(process.env.PO || '').trim();
const LINE = String(process.env.LINE || '').trim();
const EXPECT_CODE = String(process.env.EXPECT_CODE || '').trim();
const norm = (s) => String(s ?? '').trim().toUpperCase();
const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v));
const ROLLBACK = Symbol('plan-rollback');

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (PO && (!LINE || !EXPECT_CODE)) {
  bad('PO needs LINE (line id or current item code) and EXPECT_CODE (the code it must become)');
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* Every write method refused before the shim sees it: the derivation must only read. */
function readOnlyGuard(shim) {
  const WRITES = new Set(['update', 'insert', 'upsert', 'delete', 'rpc']);
  return new Proxy(shim, {
    get(target, prop, recv) {
      if (prop === 'rpc') return () => { throw new Error('realign: rpc refused'); };
      if (prop !== 'from') return Reflect.get(target, prop, recv);
      return (table) => new Proxy(target.from(table), {
        get(bt, p, r) {
          if (WRITES.has(String(p))) return () => { throw new Error(`realign: ${String(p)} on ${table} refused in the derivation`); };
          return Reflect.get(bt, p, r);
        },
      });
    },
  });
}

async function census() {
  const rows = await sql`
    SELECT p.po_number, p.status::text AS po_status, pi.id::text AS id, pi.item_code, pi.item_group,
           coalesce(pi.received_qty,0)::numeric AS recv, s.doc_no AS so_doc_no, s.item_code AS so_code,
           s.item_group AS so_group, p.updated_at
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
      JOIN scm.mfg_sales_order_items s ON s.id = pi.so_item_id
     WHERE p.company_id = ${CO} AND p.status::text <> 'CANCELLED'
       AND coalesce(s.cancelled, false) = false
       AND upper(btrim(pi.item_code)) <> upper(btrim(s.item_code))
     ORDER BY p.po_number, pi.item_code`;
  note(`LIST company ${CO}: ${rows.length} live PO line(s) whose item code differs from their linked sales-order line`);
  for (const r of rows) {
    say(`   ${r.po_number} [${r.po_status}] "${r.item_code}" (${r.item_group}) recv ${Number(r.recv)}  <-  ${r.so_doc_no} "${r.so_code}" (${r.so_group})  line ${r.id}`);
  }
}

async function main() {
  if (!PO) { await census(); return; }

  const [po] = await sql`
    SELECT id::text AS id, po_number, status::text AS status, supplier_id::text AS supplier_id, company_id,
           subtotal_sen, total_sen
      FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number = ${PO}`;
  if (!po) { bad(`${PO}: not found in company ${CO}`); return; }
  if (po.status === 'CANCELLED') { bad(`${PO} is CANCELLED — refusing`); return; }

  const lines = await sql`
    SELECT id::text AS id, item_code, material_name, description, supplier_sku, qty, received_qty,
           unit_price_sen, discount_sen, line_total_sen, item_group, variants, description2,
           warehouse_id::text AS warehouse_id, delivery_date::text AS delivery_date, photo_urls,
           so_item_id::text AS so_item_id
      FROM scm.purchase_order_items
     WHERE purchase_order_id = ${po.id} AND company_id = ${CO}`;
  const hits = lines.filter((l) => l.id === LINE || norm(l.item_code) === norm(LINE));
  if (hits.length !== 1) { bad(`${PO}: LINE "${LINE}" matches ${hits.length} line(s) — name exactly one (use its id)`); return; }
  const line = hits[0];
  say(`${PO} [${po.status}] line ${line.id} "${line.item_code}" qty ${Number(line.qty)} received ${Number(line.received_qty ?? 0)}`);

  if (!line.so_item_id) { bad('the line is not linked to a sales-order line — nothing to realign from'); return; }
  const [so] = await sql`
    SELECT s.id::text AS id, s.doc_no, s.line_no, s.item_code, s.item_group, s.qty, s.variants,
           s.warehouse_id::text AS warehouse_id, s.line_delivery_date::text AS line_delivery_date,
           s.description, s.photo_urls, coalesce(s.cancelled,false) AS cancelled, h.company_id
      FROM scm.mfg_sales_order_items s JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE s.id = ${line.so_item_id}`;
  if (!so || Number(so.company_id) !== CO) { bad(`linked sales-order line ${line.so_item_id} is not in company ${CO}`); return; }
  say(`   linked to ${so.doc_no} line ${so.line_no ?? '?'} "${so.item_code}" (${so.item_group}) qty ${Number(so.qty)} description ${show(so.description)}`);
  if (so.cancelled) { bad('the linked sales-order line is cancelled — refusing'); return; }
  if (norm(line.item_code) === norm(so.item_code)) { note(`already aligned: the PO line and its sales-order line both carry "${so.item_code}". Nothing to write.`); return; }
  if (norm(so.item_code) !== norm(EXPECT_CODE)) { bad(`the sales-order line carries "${so.item_code}", not EXPECT_CODE "${EXPECT_CODE}" — refusing`); return; }
  if (Number(line.received_qty ?? 0) > 0) { bad('the line has been received — its stock is booked under the old code; refusing'); return; }

  const { rederivePoLineFromSoLine } = await import('../src/scm/lib/po-line-rederive.ts');
  const { pgrestShim } = await import('./lib/pgrest-shim.mjs');
  const shim = pgrestShim(sql, 'scm');
  const { patch, warnings } = await rederivePoLineFromSoLine(readOnlyGuard(shim), {
    poLineId: line.id,
    currentQty: Number(line.qty),
    po: { po_number: po.po_number, supplier_id: po.supplier_id, company_id: po.company_id },
    soCompanyId: Number(so.company_id),
    revised: {
      item_code: so.item_code, item_group: so.item_group, qty: so.qty == null ? null : Number(so.qty),
      variants: so.variants ?? null, warehouse_id: so.warehouse_id, line_delivery_date: so.line_delivery_date,
      description: so.description, photo_urls: so.photo_urls ?? null,
    },
  });
  if (shim.__gaps?.length) { bad(`pgrest-shim gaps: ${shim.__gaps.join(' | ')}`); return; }
  for (const w of warnings) note(`derivation warning: ${w}`);
  if (patch.variants != null && (typeof patch.variants !== 'object' || Array.isArray(patch.variants))) {
    bad(`derived variants is not an object: ${show(patch.variants)} — refusing`); return;
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    || (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : false);
  const changes = Object.entries(patch).filter(([k, v]) => !same(line[k], v));
  say('   PLANNED CHANGES (column: now -> after):');
  for (const [k, v] of changes) say(`      ${k}: ${show(line[k])} -> ${show(v)}`);
  const delta = Number(patch.line_total_sen) - Number(line.line_total_sen ?? 0);
  if (delta !== 0) say(`   header subtotal/total move by ${delta} sen (${po.subtotal_sen} / ${po.total_sen})`);
  const [sumRow] = await sql`SELECT coalesce(sum(line_total_sen),0)::bigint AS s FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id}`;
  const headerWasSum = Number(sumRow.s) === Number(po.subtotal_sen);

  const cols = changes.map(([k]) => k);
  const EXPECTED_KEYS = ['qty', 'item_code', 'material_name', 'description', 'supplier_sku', 'unit_price_sen',
    'line_total_sen', 'item_group', 'variants', 'description2', 'warehouse_id', 'delivery_date', 'photo_urls'];
  const extra = Object.keys(patch).filter((k) => !EXPECTED_KEYS.includes(k));
  const missing = EXPECTED_KEYS.filter((k) => !(k in patch));
  if (extra.length || missing.length) {
    bad(`the derivation's column set changed (extra ${extra.join(',') || '-'}, missing ${missing.join(',') || '-'}) — update this script before writing`);
    return;
  }
  if (process.env.READ_ONLY === '1' && !APPLY) { note('READ_ONLY=1: stopped before opening the write transaction.'); return; }

  try {
    await sql.begin(async (tx) => {
      /* variants bound as an OBJECT through tx.json, never a pre-serialized
         string (docs/jsonb-double-encoding-coe.md). */
      const back = await tx`
        UPDATE scm.purchase_order_items
           SET qty = ${patch.qty}, item_code = ${patch.item_code}, material_name = ${patch.material_name},
               description = ${patch.description}, supplier_sku = ${patch.supplier_sku},
               unit_price_sen = ${patch.unit_price_sen}, line_total_sen = ${patch.line_total_sen},
               item_group = ${patch.item_group},
               variants = ${patch.variants == null ? null : tx.json(patch.variants)},
               description2 = ${patch.description2}, warehouse_id = ${patch.warehouse_id},
               delivery_date = ${patch.delivery_date}, photo_urls = ${tx.array(patch.photo_urls ?? [])}
         WHERE id = ${line.id} AND company_id = ${CO}
           AND item_code = ${line.item_code} AND qty = ${line.qty}
           AND so_item_id = ${line.so_item_id} AND coalesce(received_qty,0) = 0
        RETURNING id`;
      if (back.length !== 1) throw new Error(`expected 1 line updated, got ${back.length} — the line moved since the plan`);
      if (delta !== 0) {
        await tx`UPDATE scm.purchase_orders
                    SET subtotal_sen = subtotal_sen + ${delta}, total_sen = total_sen + ${delta}, updated_at = now()
                  WHERE id = ${po.id} AND company_id = ${CO}`;
      }
      await tx`
        INSERT INTO scm.entity_audit_log
          (entity_type, entity_id, entity_doc_no, company_id, action, actor_id, actor_name_snapshot,
           field_changes, status_snapshot, source, note)
        VALUES ('PURCHASE_ORDER', ${po.id}, ${po.po_number}, ${CO}, 'UPDATE', NULL, 'realign-po-line-to-so-line',
                ${tx.json(changes.map(([k, v]) => ({ field: k, from: line[k] ?? null, to: v ?? null })))},
                ${po.status}, 'repair',
                ${`Line realigned to ${so.doc_no} line ${so.line_no ?? ''}: ${line.item_code} -> ${so.item_code} (the approved amendment's re-derive)`})`;
      note(`${APPLY ? 'wrote' : 'would write'}: 1 line (${cols.length} column(s) change), ${delta ? 'header totals, ' : ''}1 audit row`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note('PLAN: transaction rolled back, nothing was written.');
    await verify({ po, line, so, patch, cols, headerWasSum, expectWritten: false });
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    return;
  }
  await verify({ po, line, so, patch, cols, headerWasSum, expectWritten: true });
}

async function verify({ po, line, so, patch, cols, headerWasSum, expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failures = 0;
  const fail = (m) => { failures += 1; bad(m); };
  try {
    const [got] = await check`
      SELECT pi.*, pi.so_item_id::text AS so_link, pi.warehouse_id::text AS warehouse_id,
             pi.delivery_date::text AS delivery_date, jsonb_typeof(pi.variants) AS variants_type,
             s.item_code AS so_code
        FROM scm.purchase_order_items pi LEFT JOIN scm.mfg_sales_order_items s ON s.id = pi.so_item_id
       WHERE pi.id = ${line.id}`;
    const [hdr] = await check`
      SELECT p.subtotal_sen, (SELECT coalesce(sum(line_total_sen),0)::bigint FROM scm.purchase_order_items WHERE purchase_order_id = p.id) AS sum_lines
        FROM scm.purchase_orders p WHERE p.id = ${po.id}`;
    say('\n=== VERIFIED ON A FRESH CONNECTION ===');
    if (!got) { fail('the line disappeared'); return; }
    if (got.so_link !== line.so_item_id) fail(`so_item_id moved: ${line.so_item_id} -> ${got.so_link}`);
    if (got.variants != null && got.variants_type !== 'object') fail(`variants is jsonb ${got.variants_type}`);
    if (expectWritten) {
      for (const k of cols) {
        const want = patch[k];
        const ok = JSON.stringify(got[k] ?? null) === JSON.stringify(want ?? null) || Number(got[k]) === Number(want);
        if (!ok) fail(`${k}: expected ${show(want)}, reads ${show(got[k])}`);
      }
      if (norm(got.item_code) !== norm(so.item_code)) fail(`item code ${got.item_code} still differs from the sales-order line's ${got.so_code}`);
      if (headerWasSum && Number(hdr.subtotal_sen) !== Number(hdr.sum_lines)) fail(`header subtotal ${hdr.subtotal_sen} no longer equals its lines ${hdr.sum_lines}`);
    } else if (got.item_code !== line.item_code) {
      fail(`PLAN changed the row: item_code ${line.item_code} -> ${got.item_code}`);
    }
    say(`   line "${got.item_code}" group ${got.item_group} supplier_sku ${show(got.supplier_sku)} description ${show(got.description)} variants ${show(got.variants)} (${got.variants_type})`);
    say(`   header subtotal ${hdr.subtotal_sen} / lines ${hdr.sum_lines}`);
  } finally {
    await check.end({ timeout: 5 });
    if (failures) { bad(`VERIFY: ${failures} failure(s)`); process.exitCode = 3; }
    else note(`VERIFY: shape holds (${expectWritten ? 'written' : 'unchanged'})`);
  }
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
