#!/usr/bin/env node
// Make the eleven seeded special-order codes read the way the owner's own 26
// already read.
//
// Owner 2026-08-10: "我刚刚又发你照片啊,为什么你不是跟着我的?" — fair. The
// seeder deduplicated on an EXACT code/label match, so it never noticed that
// "Fully Cover To Floor No Leg" is the owner's existing "Seat Base Fully Cover
// with no Leg", or that his four back-cushion swaps are all spelled
// "Change to <model> backcushion" and mine was not.
//
// Safe to do now and only now: these eleven were created minutes ago and NO
// order line references them yet. Once the special-order backfill starts, a
// rename would orphan whatever points at the old code.
//
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// from -> to, following the owner's spelling. `null` = delete, it duplicates one of his.
const RENAME = [
  // Owner dictated these spellings himself, 2026-08-10. His own list is not
  // internally consistent ("Change 8030 Backcushion" beside "change to 9028
  // back cushion") - that is his call, not something to tidy. Follow it.
  ["Back Cushion Change 5535 Design", "change to 5535 back cushion", "his four existing swaps read 'change to <model> back cushion'"],
  ["Extend To Floor With 1inch Leg", "Seat Fully Cover with 1inches leg", "owner's own wording"],
  ["Sitting Cushion Add Height 1inch", "Seat Cushion Add Height 1inch", "he writes 'Seat ...', not 'Sitting ...'"],
  ["Leg Change - Altay Glossy Black", "Leg Change Altay Glossy Black", "he does not use ' - ' in a code"],
  ["Umbrella Fabric Bottom (Sofa)", "Umbrella Fabric Bottom", "match his 'Nylon Fabric Bottom'"],
];

const DELETE = [
  ["Fully Cover To Floor No Leg", "duplicates his 'Seat Base Fully Cover with no Leg'"],
];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);
  const rows = await sql`SELECT id, code, label FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  log(`specials on file: ${rows.length}`);
  const byCode = new Map(rows.map((r) => [r.code.trim().toUpperCase(), r]));

  /* A code is only safe to touch while nothing points at it. custom_specials is
     the free-text list an order line carries, so search it for the old spelling
     before renaming or deleting. */
  const inUse = async (code) => {
    const [{ n: a }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${'%' + code + '%'}`;
    const [{ n: b }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${'%' + code + '%'}`;
    return a + b;
  };

  const plan = [];
  for (const [from, to, why] of RENAME) {
    const hit = byCode.get(from.toUpperCase());
    if (!hit) { log(`  skip rename ${from} — not found`); continue; }
    if (byCode.has(to.toUpperCase())) { log(`  skip rename ${from} — "${to}" already exists`); continue; }
    const used = await inUse(from);
    plan.push({ kind: "rename", id: hit.id, from, to, why, used });
  }
  for (const [code, why] of DELETE) {
    const hit = byCode.get(code.toUpperCase());
    if (!hit) { log(`  skip delete ${code} — not found`); continue; }
    const used = await inUse(code);
    plan.push({ kind: "delete", id: hit.id, from: code, why, used });
  }

  log("");
  for (const p of plan) {
    log(`  ${p.kind.toUpperCase()} "${p.from}"${p.to ? ` -> "${p.to}"` : ""}`);
    log(`      why: ${p.why}`);
    log(`      lines referencing it: ${p.used}${p.used ? "  <-- REFUSING" : ""}`);
  }
  const blocked = plan.filter((p) => p.used > 0);
  if (blocked.length) { log("\nREFUSING — a code is already referenced by an order line. Rename it in the UI so the reference follows."); await sql.end(); return; }
  if (!plan.length) { log("nothing to do"); await sql.end(); return; }
  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  for (const p of plan) {
    if (p.kind === "rename") await sql`UPDATE scm.special_addons SET code = ${p.to}, label = ${p.to} WHERE id = ${p.id}`;
    else await sql`DELETE FROM scm.special_addons WHERE id = ${p.id}`;
  }
  log(`APPLIED — ${plan.filter((p) => p.kind === "rename").length} renamed, ${plan.filter((p) => p.kind === "delete").length} deleted.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
