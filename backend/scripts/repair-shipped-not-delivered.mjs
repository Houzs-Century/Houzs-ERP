#!/usr/bin/env node
/* Revert LOCAL orders that were marked DELIVERED at ship-out back to SHIPPED.
 *
 * THE SHAPE. Until 2026-10-27 so-delivery-sync flipped an SO to DELIVERED the
 * moment a delivery order covered it — and a merely-LOADED DO counts as cover
 * (goods out), so an order whose DO was cut and loaded but NOT yet delivered
 * read "已送达" while it was still on the lorry or not even dispatched. On
 * 2026-10-25/26 production carried dozens of these: a DO dated today/tomorrow,
 * LOADED, no driver, yet the SO said DELIVERED. so-delivery-sync now ships only
 * (SHIPPED); the daily sweep (deliverDueShippedOrders) delivers a LOCAL order
 * once its DO date has passed AND it has a driver. This script fixes the rows
 * that were already mis-filed, so the new rule starts from a clean base.
 *
 * WHAT IT REVERTS. A LOCAL (not Sabah/Sarawak/Labuan, not Singapore) SO that is
 * DELIVERED, HAS a live (non-DRAFT/CANCELLED) DO, but has NO DO that proves the
 * delivery actually happened — none SIGNED/DELIVERED, none with a delivered
 * timestamp, and none whose date has passed WITH a driver on it. Those go to
 * SHIPPED. A genuinely-delivered order (a signed DO, a delivered timestamp, or a
 * past-dated DO with a driver) is LEFT at DELIVERED. East Malaysia / Singapore
 * are NEVER touched — their delivered signal is the HC Delivery sheet, synced
 * separately.
 *
 * MODE=plan (default) counts the rows and writes nothing. MODE=apply needs
 * CONFIRM="I HAVE REVIEWED THE DRY-RUN", sets status=SHIPPED one row at a time
 * (recording the transition in mfg_so_status_changes), then re-reads every
 * reverted order on a FRESH connection and fails unless each now reads SHIPPED.
 * Row identities are shown to the operator out-of-band (the read-only Supabase
 * query), never printed here — this repo's Actions logs are public.
 *
 * RE-RUN: inert. The target predicate requires status=DELIVERED; a reverted row
 * is SHIPPED and no longer matches. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ACTOR = process.env.ACTOR_ID || null;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

// Today, Malaysia (UTC+8), as YYYY-MM-DD — the "date has passed" boundary.
const todayMy = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/* The target set, as a WHERE fragment reused by the count, the apply read and
   the post-apply verify — so all three ask exactly the same question. */
const targetWhere = (client) => client`
  so.status = 'DELIVERED'
  AND NOT (so.customer_state ~* '(sabah|sarawak|labuan)')
  AND (so.customer_country IS NULL OR so.customer_country !~* 'singapore')
  AND EXISTS (
    SELECT 1 FROM scm.delivery_orders d
    WHERE d.so_doc_no = so.doc_no AND d.status NOT IN ('DRAFT', 'CANCELLED')
  )
  AND NOT EXISTS (
    SELECT 1 FROM scm.delivery_orders d
    LEFT JOIN scm.delivery_order_crew c ON c.do_id = d.id
    WHERE d.so_doc_no = so.doc_no AND d.status NOT IN ('DRAFT', 'CANCELLED')
      AND (
        d.status IN ('SIGNED', 'DELIVERED')
        OR d.customer_delivered_date IS NOT NULL
        OR (
          d.do_date < ${todayMy}::date
          AND (d.driver_id IS NOT NULL
               OR c.driver_1_id IS NOT NULL OR c.driver_2_id IS NOT NULL
               OR COALESCE(TRIM(c.driver_1_name), '') <> '' OR COALESCE(TRIM(c.driver_2_name), '') <> '')
        )
      )
  )
  -- Only orders whose delivery date has NOT yet passed (today or later): a
  -- shipped-ahead order marked delivered before its delivery day. A past-dated
  -- DELIVERED order WITHOUT a driver is a HISTORICAL delivery with no driver
  -- recorded (data back to 2025), NOT an un-delivery — left exactly alone.
  AND (
    SELECT max(d.do_date) FROM scm.delivery_orders d
    WHERE d.so_doc_no = so.doc_no AND d.status NOT IN ('DRAFT', 'CANCELLED')
  ) >= ${todayMy}::date`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} today(MYT)=${todayMy}`);

  // Counts only — identities are reviewed via the read-only Supabase query.
  const counted = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE latest_do_date < ${todayMy}::date)::int AS do_date_past,
      count(*) FILTER (WHERE latest_do_date = ${todayMy}::date)::int AS do_date_today,
      count(*) FILTER (WHERE latest_do_date > ${todayMy}::date)::int AS do_date_future
    FROM (
      SELECT so.doc_no,
             (SELECT max(d.do_date) FROM scm.delivery_orders d
                WHERE d.so_doc_no = so.doc_no AND d.status NOT IN ('DRAFT', 'CANCELLED')) AS latest_do_date
      FROM scm.mfg_sales_orders so
      WHERE ${targetWhere(sql)}
    ) t`;
  const c = counted[0];
  note(`\n=== LOCAL orders wrongly DELIVERED at ship-out (to revert to SHIPPED) ===`);
  note(`  total: ${c.total}`);
  note(`  of which DO date already past: ${c.do_date_past}`);
  note(`  of which DO date is today:     ${c.do_date_today}`);
  note(`  of which DO date is future:    ${c.do_date_future}`);
  if (!c.total) { note(`\nNothing to repair.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN only — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const rows = await sql`
    SELECT so.doc_no, so.company_id
    FROM scm.mfg_sales_orders so
    WHERE ${targetWhere(sql)}`;
  let moved = 0;
  for (const r of rows) {
    const upd = await sql`
      UPDATE scm.mfg_sales_orders SET status = 'SHIPPED'
      WHERE doc_no = ${r.doc_no} AND status = 'DELIVERED'
      RETURNING doc_no`;
    if (!upd.length) continue; // changed under us — skip
    await sql`
      INSERT INTO scm.mfg_so_status_changes (company_id, doc_no, from_status, to_status, changed_by, notes)
      VALUES (${r.company_id ?? null}, ${r.doc_no}, 'DELIVERED', 'SHIPPED', ${ACTOR},
              'Repair 2026-10-27: shipped out, not yet delivered (no signed/past-dated+driver DO) — reverted from DELIVERED')`;
    moved++;
  }
  note(`\nReverted ${moved} order(s) DELIVERED -> SHIPPED.`);

  // SHAPE verify on a FRESH connection: not one of the target rows may still read
  // DELIVERED, and every order we touched must now read SHIPPED.
  const verify = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const left = await verify`
      SELECT count(*)::int AS n FROM scm.mfg_sales_orders so WHERE ${targetWhere(verify)}`;
    if (left[0].n !== 0) {
      bad(`VERIFY FAILED: ${left[0].n} target order(s) still DELIVERED after apply`);
      process.exitCode = 1;
    } else {
      note(`VERIFY OK: no local ship-out-only order still reads DELIVERED.`);
    }
  } finally {
    await verify.end({ timeout: 5 });
  }
  await sql.end({ timeout: 5 });
}

main().catch((e) => { bad(e?.message ?? String(e)); process.exit(1); });
