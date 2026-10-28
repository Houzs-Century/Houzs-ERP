#!/usr/bin/env node
// Park company_2 (2990) sales staff under the 2990 showroom warehouse (2990s PJ)
// — sets scm.staff.showroom_warehouse_id so their SOs bind to that showroom's
// venue (venue-binding.ts / mig 0148). Owner 2026-07-23: "四个人都 mark 他的
// showroom under 2990s 的". Reports every staff it parks. DRY-RUN unless APPLY=1.
//
// NOTE: the showroom's venue only RESOLVES once 2990s PJ has a venue_name set —
// this parking + backfill-2990-so-venue.mjs both wait on that one field.
//
// RE-RUN: convergent. Parks the same staff at the same showroom, overwriting a showroom a person may have changed since.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [c] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // The single 2990 showroom warehouse.
  const sr = await dst`
    SELECT id, code, name, venue_name FROM scm.warehouses
     WHERE company_id=${cid} AND is_showroom = true ORDER BY name`;
  if (sr.length !== 1) { log(`expected exactly ONE 2990 showroom, found ${sr.length} — refusing. ${sr.map(w=>w.name).join(", ")}`); return; }
  const wh = sr[0];
  log(`showroom: [${wh.code}] ${wh.name}  venue_name=${wh.venue_name ? `"${wh.venue_name}"` : "(BLANK — set it in Warehouses for venue to resolve)"}`);

  // Company_2 SALES staff (position slug sales%), active, linked to a user.
  const staff = await dst`
    SELECT s.id, s.staff_code, s.name, s.showroom_warehouse_id
      FROM scm.staff s
      JOIN public.user_companies uc ON uc.user_id = s.user_id AND uc.company_id = ${cid}
      LEFT JOIN public.users u ON u.id = s.user_id
      LEFT JOIN public.positions pn ON pn.id = u.position_id
     WHERE s.active = true AND s.user_id IS NOT NULL AND pn.slug LIKE 'sales%'
     ORDER BY s.name`;
  log("");
  log(`=== ${staff.length} company_2 sales staff ===`);
  const toPark = [];
  for (const s of staff) {
    const already = String(s.showroom_warehouse_id ?? "") === String(wh.id);
    log(`  ${s.name} [${s.staff_code}] — ${already ? "already parked here" : (s.showroom_warehouse_id ? "parked elsewhere -> repoint" : "not parked -> park")}`);
    if (!already) toPark.push(s.id);
  }
  log("");
  log(`would park ${toPark.length} staff under ${wh.name}`);
  if (!APPLY || toPark.length === 0) { if (!APPLY) log("DRY-RUN — no writes. APPLY=1 to park."); return; }
  for (const id of toPark) await dst`UPDATE scm.staff SET showroom_warehouse_id=${wh.id} WHERE id=${id}`;
  log(`APPLIED — parked ${toPark.length} staff under ${wh.name}.`);
}
main().then(() => dst.end()).catch(async (e) => { console.error("PARK_FAIL", e.message); try { await dst.end(); } catch {} process.exit(1); });
