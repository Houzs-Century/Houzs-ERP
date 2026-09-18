#!/usr/bin/env node
/* Read-only. Why a salesperson could neither SAVE nor AMEND 2990-SO-2608-020,
 * and how many other orders sit in the same shape.
 *
 * THE OWNER'S RULE (2026-08-16), two states and nothing between them:
 *   (3) not yet proceeded            -> edit it DIRECTLY.
 *   (4) proceeded, and a day passed  -> it locked; go through Sales Amendment.
 *
 * THE LIVE FAILURE. The operator's console showed 409 (x2) on this doc plus the
 * sentence curated for `so_version_conflict` only
 * (frontend/src/vendor/scm/lib/authed-fetch.ts:503). The order is CONFIRMED with
 * NO processing_date, so it is NOT locked -> the amendment door answers 409
 * not_locked_no_amendment_needed (mfg-sales-orders.ts:11743). Both doors shut.
 *
 * The refusal is the OPTIMISTIC LOCK, so the question is: what moved
 * mfg_sales_orders.version out from under a human who had the page open?
 * Two candidates, and the AUDIT TRAIL tells them apart:
 *
 *   [E1] A NON-HUMAN writer. `advanceSoGeneration` (lib/so-generation.ts:44)
 *        does `version: version + 1` and is called by the stock-allocation
 *        projection (lib/so-stock-allocation.ts:758 advance / :766 regress),
 *        which the five-minute cron drains (index.ts:538-551). Each flip
 *        writes an audit row with actor_name_snapshot 'System (auto-allocate)'
 *        and source 'automation' (so-stock-allocation.ts:322-332). If those rows
 *        exist around the failure, a cron was bumping the version under him.
 *
 *   [E2] His OWN earlier save committed but the response never arrived — there
 *        is a 504 in the same console. Then the audit shows a HUMAN row
 *        (source 'web', his name) whose version bump he never learned about,
 *        because the client never re-syncs loadedVersionRef from a 409 body.
 *
 * These are distinguishable ONLY by evidence, so this probe prints the trail
 * rather than a verdict, and prints the inputs beside every number.
 *
 * status is compared as ::text throughout — scm.mfg_sales_orders.status is an
 * enum and an uncast comparison is what broke the readiness probe (#2299).
 *
 * Writes nothing. SELECTs only. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const raw = (m) => console.log(m);

/* The EXACT expression soProcessingLocked uses (mfg-sales-orders.ts:466), so
   the probe cannot agree with itself by using a different clock. */
const TODAY_MY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const NEVER_LOCK_STATUS = ["DRAFT", "CANCELLED"];                                    // :470
const TERMINAL_STATUS = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "CANCELLED"]; // :2655
const DOC = (process.env.DOC || "2990-SO-2608-020").trim();

async function main() {
  raw(`\n================ INPUTS ================`);
  raw(`  doc under investigation: ${DOC}`);
  raw(`  today (Malaysia, UTC+8, same expr as the route): ${TODAY_MY}`);
  raw(`  soProcessingLocked = processing_date < '${TODAY_MY}' AND upper(status) NOT IN (${NEVER_LOCK_STATUS.join(", ")})`);
  raw(`  soPoLocked applies ONLY to doc_no LIKE '2990-%' (so-po-lock.ts isMirroredDocNo)`);
  raw(`  edit lease TTL = 5 minutes (mfg-sales-orders.ts:7274)`);
  raw(`  DB: ${String(process.env.DATABASE_URL || "").replace(/:[^:@/]*@/, ":***@").slice(0, 55)}...`);

  /* ── [E] the named order, exactly as the guards see it ─────────────────── */
  raw(`\n================ [E] THE ORDER AS THE GUARDS SEE IT ================`);
  const [so] = await sql`
    SELECT doc_no, company_id, status::text AS status, version, revision,
           processing_date, proceeded_at, customer_delivery_date,
           edit_lease_token, edit_lease_expires_at, updated_at, created_at
      FROM scm.mfg_sales_orders WHERE doc_no = ${DOC}`;
  if (!so) {
    raw(`  NOT FOUND — nothing else can be said about it.`);
  } else {
    for (const [k, v] of Object.entries(so)) raw(`  ${k.padEnd(24)} ${v === null ? "(null)" : v}`);
    const dateLocked =
      so.processing_date != null &&
      String(so.processing_date).slice(0, 10) < TODAY_MY &&
      !NEVER_LOCK_STATUS.includes(String(so.status).toUpperCase());
    const [{ has_live_po }] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM scm.mfg_sales_order_items soi
          JOIN scm.purchase_order_items poi ON poi.so_item_id = soi.id
          JOIN scm.purchase_orders po       ON po.id = poi.purchase_order_id
         WHERE soi.doc_no = ${DOC}
           AND upper(coalesce(po.status::text,'')) <> 'CANCELLED') AS has_live_po`;
    const poLocked = DOC.startsWith("2990-") && has_live_po;
    raw(`\n  VERDICTS (inputs above):`);
    raw(`    soProcessingLocked : ${dateLocked}`);
    raw(`    has a live PO      : ${has_live_po}`);
    raw(`    soPoLocked         : ${poLocked}`);
    raw(`    soEditLocked       : ${dateLocked || poLocked}`);
    raw(`    => amendment door  : ${dateLocked || poLocked ? "OPEN" : "409 not_locked_no_amendment_needed"}`);
    const leaseLive = so.edit_lease_token && so.edit_lease_expires_at &&
      Date.parse(so.edit_lease_expires_at) > Date.now();
    raw(`    edit lease held now: ${leaseLive ? `YES (expires ${so.edit_lease_expires_at})` : "no"}`);
  }

  /* ── [L] the lines as they stand, with what would mark an AUTO-ADDED one ── */
  raw(`
================ [L] THE LINES, AND WHETHER EACH IS A GIFT ================`);
  const lines = await sql`
    SELECT i.line_no, i.item_code, i.item_group, i.description, i.qty, i.unit_price_sen, i.cancelled,
           i.created_at, i.variants, p.sell_price_sen AS catalog_sell_sen
      FROM scm.mfg_sales_order_items i
      LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
     WHERE i.doc_no = ${DOC}
     ORDER BY i.line_no NULLS LAST, i.created_at`;
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 19) : String(d ?? "-"));
  if (!lines.length) raw(`  no lines`);
  for (const l of lines) {
    const v = l.variants && typeof l.variants === "object" ? l.variants : {};
    raw(`  #${String(l.line_no ?? "-").padEnd(3)} ${String(l.item_code ?? "").padEnd(22)} group=${String(l.item_group ?? "-").padEnd(10)} qty=${String(l.qty).padEnd(3)} unit=RM${(Number(l.unit_price_sen ?? 0) / 100).toFixed(2).padStart(9)}  catalog=RM${l.catalog_sell_sen == null ? "   (none)" : (Number(l.catalog_sell_sen) / 100).toFixed(2).padStart(9)}  freeGift=${v.freeGift == null ? "-" : JSON.stringify(v.freeGift)}  pwpCode=${v.pwpCode ?? "-"}  cancelled=${l.cancelled}  created=${iso(l.created_at)}  ${String(l.description ?? "").slice(0, 40)}`);
    raw(`        variants: ${JSON.stringify(v).slice(0, 200)}`);
  }
  raw(`  READ THIS AS: freeGift=true at RM0.00 is a line the campaign trigger treated as a gift;`);
  raw(`  a priced line with no tag was picked and priced like any other item. catalog= is the`);
  raw(`  product's list price today, so unit=RM0.00 with catalog=RM0.00 is "free by list", not a grant.`);

  /* ── [P] is a RM0 pillow the app's habit or this order's? Census of the book ── */
  const PREFIX = DOC.split("-")[0] + "-";
  raw(`
================ [P] SQUARE PILLOW CENSUS, orders LIKE '${PREFIX}%', last 60 days ================`);
  const [cen] = await sql`
    WITH so AS (
      SELECT doc_no, created_at FROM scm.mfg_sales_orders
       WHERE doc_no LIKE ${PREFIX + "%"} AND created_at > now() - interval '60 days'
         AND upper(status::text) <> 'CANCELLED'),
    sofa AS (
      SELECT DISTINCT doc_no FROM scm.mfg_sales_order_items
       WHERE doc_no LIKE ${PREFIX + "%"} AND NOT coalesce(cancelled, false)
         AND item_code <> 'SQUARE PILLOW'
         AND (lower(coalesce(item_group, '')) = 'sofa' OR description ILIKE 'SOFA %')),
    pill AS (
      SELECT i.doc_no, min(i.unit_price_sen) AS unit_min, max(i.unit_price_sen) AS unit_max,
             bool_or(i.variants->>'freeGift' IS NOT NULL) AS tagged,
             bool_or(i.created_at > s.created_at + interval '10 seconds') AS added_later
        FROM scm.mfg_sales_order_items i JOIN so s USING (doc_no)
       WHERE i.item_code = 'SQUARE PILLOW' AND NOT coalesce(i.cancelled, false)
       GROUP BY i.doc_no)
    SELECT count(*)::int                                                              AS orders,
           count(*) FILTER (WHERE sofa.doc_no IS NOT NULL)::int                       AS sofa_orders,
           count(*) FILTER (WHERE sofa.doc_no IS NOT NULL AND pill.doc_no IS NOT NULL)::int AS sofa_with_pillow,
           count(*) FILTER (WHERE sofa.doc_no IS NOT NULL AND pill.unit_max = 0)::int  AS sofa_with_rm0_pillow,
           count(*) FILTER (WHERE sofa.doc_no IS NOT NULL AND pill.unit_min > 0)::int  AS sofa_with_priced_pillow,
           count(*) FILTER (WHERE pill.tagged)::int                                    AS pillow_tagged_gift,
           count(*) FILTER (WHERE pill.added_later)::int                               AS pillow_added_after_create,
           count(*) FILTER (WHERE sofa.doc_no IS NULL AND pill.doc_no IS NOT NULL)::int AS nonsofa_with_pillow
      FROM so LEFT JOIN sofa USING (doc_no) LEFT JOIN pill USING (doc_no)`;
  raw(`  orders in window:                       ${cen.orders}`);
  raw(`  ..with a sofa line:                     ${cen.sofa_orders}`);
  raw(`     ..of which carry a SQUARE PILLOW:    ${cen.sofa_with_pillow}`);
  raw(`        ..pillow at RM0.00:               ${cen.sofa_with_rm0_pillow}`);
  raw(`        ..pillow priced > RM0:            ${cen.sofa_with_priced_pillow}`);
  raw(`  pillow carrying a freeGift tag:         ${cen.pillow_tagged_gift}`);
  raw(`  pillow added >10s AFTER the create:     ${cen.pillow_added_after_create}   <- hand-added or reconciled later; the rest arrived IN the create`);
  raw(`  non-sofa orders carrying a pillow:      ${cen.nonsofa_with_pillow}`);
  raw(`  READ THIS AS: if nearly every sofa order has the RM0 pillow in the create itself, the`);
  raw(`  app that raises the order is putting it there; if it is scattered, people are.`);

  /* ── [E1 vs E2] the audit trail — WHO has been writing this order ──────── */
  raw(`\n================ [E1 vs E2] WHO WROTE THIS ORDER ================`);
  const trail = await sql`
    SELECT created_at, action, actor_name_snapshot, source, note, field_changes
      FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ${DOC}
     ORDER BY created_at DESC LIMIT 40`;
  if (!trail.length) raw(`  no audit rows at all`);
  for (const r of trail) {
    const fc = Array.isArray(r.field_changes)
      ? r.field_changes.map((f) => `${f.field}:${f.from}->${f.to}`).join(" ")
      : "";
    raw(`  ${String(r.created_at).slice(0, 19)}  ${String(r.action).padEnd(16)} ${String(r.actor_name_snapshot ?? "-").padEnd(24)} ${String(r.source ?? "-").padEnd(11)} ${fc.slice(0, 220)}`);
    if (r.note) raw(`      note: ${String(r.note).slice(0, 110)}`);
  }
  raw(`\n  READ THIS AS: rows with source='automation' / 'System (auto-allocate)' are E1`);
  raw(`  (a cron bumped the version with no human present). A 'web' UPDATE_* row he`);
  raw(`  does not remember making, at the 504's timestamp, is E2 (his save committed`);
  raw(`  but the response never arrived).`);

  /* How busy is the automatic writer, system-wide? A rare event and a
     once-per-5-minutes event are very different diagnoses. */
  raw(`\n================ [E1] HOW OFTEN DOES THE AUTOMATIC WRITER BUMP version? ================`);
  const auto = await sql`
    SELECT date_trunc('day', created_at)::date AS day,
           count(*)::int                       AS bumps,
           count(DISTINCT so_doc_no)::int      AS orders
      FROM scm.mfg_so_audit_log
     WHERE source = 'automation'
       AND created_at > now() - interval '14 days'
     GROUP BY 1 ORDER BY 1 DESC`;
  if (!auto.length) raw(`  no automation audit rows in 14 days — E1 is NOT firing`);
  for (const r of auto) raw(`  ${r.day}   version bumps: ${String(r.bumps).padStart(5)}   distinct orders: ${String(r.orders).padStart(5)}`);

  const [{ n: autoThisDoc }] = await sql`
    SELECT count(*)::int AS n FROM scm.mfg_so_audit_log
     WHERE so_doc_no = ${DOC} AND source = 'automation'`;
  raw(`  automation bumps on ${DOC}: ${autoThisDoc}`);

  /* ── [D] how many other orders sit in the same both-doors-shut shape ───── */
  raw(`\n================ [D] LIVE ORDERS THE CODE CALLS *UNLOCKED* ================`);
  raw(`  (the amendment door is 409 for every row below, so each depends entirely`);
  raw(`   on the direct-edit door working)`);
  const unlocked = await sql`
    WITH live AS (
      SELECT so.doc_no, so.company_id, (so.doc_no LIKE '2990-%') AS is_2990,
             (so.processing_date IS NOT NULL
              AND so.processing_date::date < ${TODAY_MY}::date
              AND upper(so.status::text) <> ALL(${NEVER_LOCK_STATUS})) AS date_locked,
             EXISTS (
               SELECT 1 FROM scm.mfg_sales_order_items soi
                 JOIN scm.purchase_order_items poi ON poi.so_item_id = soi.id
                 JOIN scm.purchase_orders po       ON po.id = poi.purchase_order_id
                WHERE soi.doc_no = so.doc_no
                  AND upper(coalesce(po.status::text,'')) <> 'CANCELLED') AS has_live_po
        FROM scm.mfg_sales_orders so
       WHERE upper(so.status::text) <> ALL(${TERMINAL_STATUS})
    )
    SELECT coalesce(company_id,0)::int AS company_id, is_2990,
           count(*)::int AS live_total,
           count(*) FILTER (WHERE NOT date_locked AND NOT (is_2990 AND has_live_po))::int AS unlocked,
           count(*) FILTER (WHERE NOT date_locked AND NOT (is_2990 AND has_live_po) AND has_live_po)::int AS unlocked_with_live_po
      FROM live GROUP BY 1,2 ORDER BY 1,2`;
  raw(`  company  2990?   live   UNLOCKED   ..of which have a LIVE PO`);
  for (const r of unlocked) {
    raw(`  ${String(r.company_id).padStart(7)}  ${String(r.is_2990).padEnd(6)} ${String(r.live_total).padStart(6)}  ${String(r.unlocked).padStart(8)}  ${String(r.unlocked_with_live_po).padStart(25)}`);
  }

  /* ── [C] do processing_date and proceeded_at move together? ────────────── */
  raw(`\n================ [C] DO processing_date AND proceeded_at MOVE TOGETHER? ================`);
  const [esc] = await sql`
    SELECT
      count(*) FILTER (WHERE processing_date IS NOT NULL AND proceeded_at IS NOT NULL)::int AS both,
      count(*) FILTER (WHERE processing_date IS NULL     AND proceeded_at IS NULL)::int     AS neither,
      count(*) FILTER (WHERE processing_date IS NULL     AND proceeded_at IS NOT NULL)::int AS proceeded_no_date,
      count(*) FILTER (WHERE processing_date IS NULL     AND proceeded_at IS NOT NULL
                         AND upper(status::text) <> ALL(${TERMINAL_STATUS})
                         AND upper(status::text) <> ALL(${NEVER_LOCK_STATUS}))::int         AS proceeded_no_date_live,
      count(*) FILTER (WHERE processing_date IS NOT NULL AND proceeded_at IS NULL)::int     AS date_no_proceed,
      count(*) FILTER (WHERE processing_date IS NOT NULL AND proceeded_at IS NULL
                         AND processing_date::date < ${TODAY_MY}::date
                         AND upper(status::text) <> ALL(${NEVER_LOCK_STATUS}))::int         AS date_past_no_proceed_locked
      FROM scm.mfg_sales_orders`;
  raw(`  both set:                                        ${esc.both}`);
  raw(`  neither set:                                     ${esc.neither}`);
  raw(`  proceeded_at set, NO processing_date:            ${esc.proceeded_no_date}`);
  raw(`     ...still LIVE -> can NEVER date-lock:         ${esc.proceeded_no_date_live}   <- escapes rule 4 permanently`);
  raw(`  processing_date set, NO proceeded_at:            ${esc.date_no_proceed}`);
  raw(`     ...date already past -> LOCKED anyway:        ${esc.date_past_no_proceed_locked}   <- locked without ever being proceeded`);

  /* ── [B] can an amendment actually carry what it claims to? ────────────── */
  raw(`\n================ [B] WHICH AMENDMENT LINE CHANNELS ARE EVER USED ================`);
  const [chan] = await sql`
    SELECT count(*)::int                                              AS rows_total,
           count(*) FILTER (WHERE new_item_code      IS NOT NULL)::int AS item_code,
           count(*) FILTER (WHERE new_variants       IS NOT NULL)::int AS variants,
           count(*) FILTER (WHERE new_qty            IS NOT NULL)::int AS qty,
           count(*) FILTER (WHERE new_unit_price_sen IS NOT NULL)::int AS unit_price,
           count(*) FILTER (WHERE new_remark         IS NOT NULL)::int AS remark,
           count(*) FILTER (WHERE upper(change_type) = 'ADD')::int     AS add_lines,
           count(*) FILTER (WHERE upper(change_type) = 'REMOVE')::int  AS remove_lines,
           count(*) FILTER (WHERE upper(change_type) = 'SPEC')::int    AS spec_lines,
           count(*) FILTER (WHERE upper(change_type) = 'QTY')::int     AS qty_lines
      FROM scm.so_amendment_lines`;
  raw(`  so_amendment_lines rows: ${chan.rows_total}`);
  raw(`    new_item_code:${String(chan.item_code).padStart(5)}   new_variants:${String(chan.variants).padStart(5)}   new_qty:${String(chan.qty).padStart(5)}`);
  raw(`    new_unit_price_sen:${String(chan.unit_price).padStart(5)}   new_remark:${String(chan.remark).padStart(5)} (col added by mig 0281)`);
  raw(`  change_type: ADD=${chan.add_lines} REMOVE=${chan.remove_lines} SPEC=${chan.spec_lines} QTY=${chan.qty_lines}`);
  raw(`  (a change_type with 0 rows is a line operation nobody has managed to request)`);

  /* Did an APPROVED amendment actually persist the price it asked for?
     applySoAmendment passes trustOperatorSelling=false for a NATIVE order
     (so-revision.ts:334), and recomputeFromSnapshot then overwrites the
     requested figure with the catalog one (mfg-pricing-recompute.ts:643). */
  const applied = await sql`
    SELECT a.amendment_no, a.status::text AS status, l.change_type,
           l.new_unit_price_sen AS requested, i.unit_price_sen AS line_now,
           (so.linked_ac_docno IS NOT NULL) AS so_migrated
      FROM scm.so_amendment_lines l
      JOIN scm.so_amendments a     ON a.id = l.amendment_id
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
      LEFT JOIN scm.mfg_sales_order_items i ON i.id = l.sales_order_item_id
     WHERE l.new_unit_price_sen IS NOT NULL
       AND a.status::text IN ('SO_APPROVED','PO_APPROVED','SENT')
     ORDER BY a.amendment_no`;
  raw(`\n  APPROVED amendments that requested a price: ${applied.length}`);
  for (const r of applied) {
    const req = r.requested == null ? null : Number(r.requested);
    const now = r.line_now == null ? null : Number(r.line_now);
    const verdict = now == null ? "line gone" : req === now ? "carried" : `DISCARDED (asked ${req}, holds ${now})`;
    raw(`  ${String(r.amendment_no).padEnd(21)} ${String(r.status).padEnd(12)} ${String(r.change_type).padEnd(7)} migrated=${String(r.so_migrated).padEnd(6)} ${verdict}`);
  }

  await sql.end({ timeout: 5 });
}
main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
