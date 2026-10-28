// One-shot correction: DOs of 2990-source-DELIVERED orders stuck at DISPATCHED.
//
// EVIDENCE (check-2990-delivered-chain, 2026-07-24): the 2990 source marks 19
// SOs DELIVERED; every one has its DO in Houzs, but 12 SOs read CONFIRMED /
// READY_TO_SHIP because their DOs sit at DISPATCHED - 2990 never had a
// "delivered" step on DOs, so the importer faithfully carried "dispatched".
// Owner ruling (2026-07-24): status follows the SOP chain - fix the DO, let
// the SO follow. "我们开了 DO 就是 consider 出货 delivered 了".
//
// WHAT APPLY DOES, mirroring the app's own DELIVERED transition
// (delivery-orders-mfg.ts PATCH status handler + syncSoDeliveredFromDo):
//   1. delivery_orders: DISPATCHED -> DELIVERED (+delivered_at, updated_at)
//   2. mfg_sales_orders: -> DELIVERED for those SOs (the app's auto-advance)
//   3. mfg_so_audit_log: one row per SO recording the backfill
// Inventory is NOT touched: the OUT movement fired at DISPATCH (idempotent
// chokepoint), exactly as in the live flow.
//
// The target set is recomputed LIVE from both databases on every run - never
// a hardcoded doc list - and APPLY re-checks each DO is still DISPATCHED, so
// the script is idempotent and a re-run after success plans 0 rows.
//
// DRY-RUN by default. APPLY=1 to write.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.env.APPLY === "1";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
const SOURCE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
if (!url || !SOURCE_URL || !SOURCE_KEY) {
  console.error("Need DATABASE_URL + SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const src = createClient(SOURCE_URL, SOURCE_KEY, { auth: { persistSession: false } });

try {
  notice(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const { data: srcRows, error: srcErr } = await src
    .from("mfg_sales_orders")
    .select("doc_no, status")
    .eq("status", "DELIVERED")
    .order("doc_no");
  if (srcErr) {
    console.error(`source query failed: ${srcErr.message}`);
    process.exit(1);
  }

  const plan = []; // { soDocNo, doIds: [{id, do_number}] }
  for (const s of srcRows) {
    const candidates = [`2990-${s.doc_no}`, s.doc_no];
    const ho = await pg`
      SELECT doc_no, status FROM scm.mfg_sales_orders
      WHERE company_id = 2 AND doc_no IN ${pg(candidates)} LIMIT 1`;
    if (ho.length === 0 || ho[0].status === "DELIVERED") continue;
    const dos = await pg`
      SELECT id, do_number, status FROM scm.delivery_orders
      WHERE company_id = 2 AND so_doc_no = ${ho[0].doc_no}
        AND status <> 'CANCELLED'`;
    if (dos.length === 0) {
      notice(`${ho[0].doc_no}: SKIP - no DO exists (needs a human decision, not this backfill).`);
      continue;
    }
    const notFlippable = dos.filter((d) => !["DISPATCHED", "DELIVERED"].includes(d.status));
    if (notFlippable.length > 0) {
      notice(
        `${ho[0].doc_no}: SKIP - DO(s) in unexpected status ` +
          `${notFlippable.map((d) => `${d.do_number}=${d.status}`).join(", ")} - review by hand.`,
      );
      continue;
    }
    plan.push({
      soDocNo: ho[0].doc_no,
      soStatus: ho[0].status,
      dos: dos.filter((d) => d.status === "DISPATCHED"),
    });
  }

  notice(`plan: ${plan.length} SO(s) to advance to DELIVERED`);
  for (const p of plan) {
    notice(
      `  ${p.soDocNo} (now ${p.soStatus}): flip ` +
        (p.dos.length ? p.dos.map((d) => d.do_number).join(", ") : "(DOs already DELIVERED)"),
    );
  }

  if (!APPLY) {
    notice("DRY-RUN - nothing written. Set APPLY=1 to write.");
    process.exit(0);
  }

  const now = new Date().toISOString();
  let dosFlipped = 0;
  let sosAdvanced = 0;
  for (const p of plan) {
    for (const d of p.dos) {
      const res = await pg`
        UPDATE scm.delivery_orders
        SET status = 'DELIVERED', delivered_at = ${now}, updated_at = ${now}
        WHERE id = ${d.id} AND status = 'DISPATCHED'`;
      dosFlipped += res.count;
    }
    const res = await pg`
      UPDATE scm.mfg_sales_orders
      SET status = 'DELIVERED', updated_at = ${now}
      WHERE company_id = 2 AND doc_no = ${p.soDocNo} AND status <> 'DELIVERED'`;
    sosAdvanced += res.count;
    await pg`
      INSERT INTO scm.mfg_so_audit_log
        (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
      VALUES
        (${p.soDocNo}, 2, 'STATUS',
         'System (2990 delivered-chain backfill)',
         ${pg.json([{ field: "status", from: p.soStatus, to: "DELIVERED" }])},
         'DELIVERED', 'backfill',
         '2990 source marked this order DELIVERED; its DO(s) were imported as DISPATCHED because 2990 had no delivered step. Backfilled per owner ruling 2026-07-24 (status follows the SOP chain).')`;
  }
  notice(`APPLIED: ${dosFlipped} DO(s) -> DELIVERED, ${sosAdvanced} SO(s) advanced. Re-run the delivered-chain check to verify all 19 read OK.`);
} finally {
  await pg.end();
}
