#!/usr/bin/env node
/* A purchase order marked RECEIVED while a line still has goods to come.

   WHY IT MATTERS. RECEIVED is terminal for receiving: the GRN routes refuse
   the PO with 409 po_not_receivable (grns.ts, from-po-items), and the
   outstanding views treat a RECEIVED PO as never outstanding. So the missing
   line drops off the PO chasing list and nobody can receive it when it does
   arrive. Seen on HC-0108 (Sim, 15 Oct): PO-9630 RECEIVED with line
   5535-L(RHF) at received 0 of 1.

   THE RULE IS THE APP'S OWN. postGrnAndRollup (grns.ts) derives both numbers
   from live GRN lines on every receipt:
     received_qty = SUM(max(0, qty_accepted - returned_qty)) over GRN lines
                    whose GRN is not DRAFT or CANCELLED;
     status       = every line received >= qty ? RECEIVED
                  : any line received > 0     ? PARTIALLY_RECEIVED
                  : SUBMITTED.
   This script applies exactly that rule to the RECEIVED POs it disagrees
   with, and to nothing else. ON_HOLD and CANCELLED are never touched.

   MODE=plan (default) lists every such PO with the short lines and writes
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", fixes one
   PO per transaction, then re-reads each PO on a fresh connection.

   RE-RUN: inert. Keyed on status = 'RECEIVED' with a line short of qty, which
   the repair turns into PARTIALLY_RECEIVED or SUBMITTED. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* One row per line of every RECEIVED PO that has a line short of qty, with the
   live receipt the app would recount it to. */
const SHORT_POS = `
  WITH live AS (
    SELECT poi.id, poi.purchase_order_id, poi.item_code, poi.qty::numeric AS qty,
           COALESCE(poi.received_qty, 0)::numeric AS received_qty,
           COALESCE((SELECT SUM(GREATEST(0, gi.qty_accepted - COALESCE(gi.returned_qty, 0)))
                       FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                      WHERE gi.purchase_order_item_id = poi.id
                        AND g.status NOT IN ('DRAFT', 'CANCELLED')), 0)::numeric AS live_qty
      FROM scm.purchase_order_items poi
  )
  SELECT po.id::text AS po_id, po.po_number, po.received_at,
         l.id::text AS line_id, l.item_code, l.qty, l.received_qty, l.live_qty
    FROM scm.purchase_orders po JOIN live l ON l.purchase_order_id = po.id
   WHERE po.company_id = $1 AND po.status = 'RECEIVED'
     AND EXISTS (SELECT 1 FROM live s WHERE s.purchase_order_id = po.id AND s.live_qty < s.qty)
   ORDER BY po.po_number, l.item_code`;

function group(rows) {
  const pos = new Map();
  for (const r of rows) {
    if (!pos.has(r.po_id)) pos.set(r.po_id, { id: r.po_id, no: r.po_number, receivedAt: r.received_at, lines: [] });
    pos.get(r.po_id).lines.push({ id: r.line_id, code: r.item_code, qty: Number(r.qty), recv: Number(r.received_qty), live: Number(r.live_qty) });
  }
  for (const p of pos.values()) {
    p.status = p.lines.some((l) => l.live > 0) ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
  }
  return [...pos.values()];
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const pos = group(await sql.unsafe(SHORT_POS, [CO]));

  note(`\n=== RECEIVED POs WITH A LINE STILL TO COME: ${pos.length} ===`);
  for (const p of pos) {
    note(`  ${p.no}  RECEIVED -> ${p.status}  (received_at ${p.receivedAt?.toISOString?.() ?? p.receivedAt ?? '-'})`);
    for (const l of p.lines) {
      const flag = l.live < l.qty ? 'SHORT' : 'ok   ';
      const drift = l.recv !== l.live ? `  received_qty ${l.recv} -> ${l.live}` : '';
      note(`      ${flag} ${String(l.code ?? '-').padEnd(24)} ${l.live} of ${l.qty}${drift}`);
    }
  }
  if (!pos.length) { note(`\nNothing to repair.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== REPAIRING ${pos.length} PO(S) ===`);
  let wrote = 0;
  for (const p of pos) {
    const done = await sql.begin(async (tx) => {
      for (const l of p.lines) {
        if (l.recv !== l.live) {
          await tx.unsafe(`UPDATE scm.purchase_order_items SET received_qty = $2 WHERE id = $1`, [l.id, l.live]);
        }
      }
      /* The status guard makes a PO someone changed since the plan read a no-op. */
      return tx.unsafe(
        `UPDATE scm.purchase_orders SET status = $2, received_at = NULL, updated_at = now()
          WHERE id = $1 AND company_id = $3 AND status = 'RECEIVED'
         RETURNING id`, [p.id, p.status, CO]);
    });
    wrote += done.length;
    note(`  ${done.length ? 'OK  ' : 'SKIP'} ${p.no} -> ${p.status}`);
  }
  note(`  written: ${wrote} of ${pos.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const p of pos) {
      const [row] = await check.unsafe(
        `SELECT po.status, po.received_at,
                (SELECT string_agg(poi.item_code || ' ' || COALESCE(poi.received_qty, 0) || '/' || poi.qty, ', ' ORDER BY poi.item_code)
                   FROM scm.purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS lines
           FROM scm.purchase_orders po WHERE po.id = $1`, [p.id]);
      const ok = row?.status === p.status && row?.received_at == null;
      (ok ? note : bad)(`  ${p.no}: status ${row?.status}, received_at ${row?.received_at ?? 'null'}; lines ${row?.lines}`);
    }
    const left = group(await check.unsafe(SHORT_POS, [CO]));
    (left.length ? bad : note)(`  RECEIVED POs still short: ${left.length}${left.length ? ` (${left.map((p) => p.no).join(', ')})` : ''}`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
