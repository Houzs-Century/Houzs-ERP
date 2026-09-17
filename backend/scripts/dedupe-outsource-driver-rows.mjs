#!/usr/bin/env node
/* Collapse the duplicate Fleet driver rows for three outsourced transporters
   (JAN, SHAKTI, Cheah) down to ONE row each, and cut the dead link to their now
   disabled staff accounts.

   WHY. These three were created as staff MEMBERS with a Driver Title (owner
   2026-09-17 has since disabled the users #92/#93/#94). A Driver-position member
   is auto-synced into scm.drivers (mig 0060 trigger), so each also spawned a
   scm.drivers row — on top of the outsource rows that already existed. On
   2026-09-17 prod carried six rows for the three people: Shakti x3 (one already
   under MSJ TRANSPORT), JAN x2, Cheah x1. The Fleet driver list therefore shows
   each of them two or three times. None of the six is referenced anywhere — 0
   trips, delivery orders, crew slots, orders, consignment DOs, leave or trip
   locations — so the duplicates are safe to remove.

   WHAT IT DOES.
     DELETE the three duplicate rows:
       157bf3be… (Shakti, no user, no company)
       c7377f48… (SHAKTI, user 93, no company)
       fb8702a0… (JAN,    user 94, no company)
     KEEP one row per person:
       dde2742e… (Shakti) — already under MSJ TRANSPORT
       6b3edf41… (Jan)    — the row with no staff-account link
       872736b3… (Cheah)  — its only row; its user_id (92, now disabled) is CLEARED
     Company for the kept JAN / Cheah rows is left for the owner to set in Fleet
     (only he knows their 3PL company); this script does not guess it.

   SAFETY. Every DELETE is refused unless the row still exists, is outsource
   (in_house = false), its name is one of the three, and it has ZERO references
   across all eight scm tables that point at scm.drivers. A reference that has
   appeared since is printed and the run aborts before any write.

   MODE=plan (default) reads and reports, writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"; it writes in one
   transaction and then re-reads on a FRESH connection to confirm the shape:
   the three targets gone, the three survivors present (one row per person), and
   Cheah's survivor no longer linked to a disabled user.

   RE-RUN: inert. A target already deleted is skipped; an already-cleared link is
   left as is; a second run reports "nothing to do". */
import postgres from "postgres";

const DELETE_IDS = [
  "157bf3be-4a77-4fb8-8f75-d8e09687b2cd",
  "c7377f48-3e59-4d71-a3b0-a171ac17e3ba",
  "fb8702a0-e565-4e0f-93b1-735bf11510ff",
];
const SURVIVOR_IDS = [
  "dde2742e-f493-4c04-b8d4-cf2c7979e41e",
  "6b3edf41-69a8-47c6-a5a9-4d27c13bf23b",
  "872736b3-4218-466b-a581-377efd3b46d3",
];
const UNLINK_IDS = ["872736b3-4218-466b-a581-377efd3b46d3"];
const EXPECTED_NAMES = new Set(["jan", "shakti", "cheah"]);

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

// Every scm table with an FK onto scm.drivers.driver_id (pg_constraint, 2026-09-17).
async function referencesFor(sql, id) {
  const r = await sql`
    SELECT
      (SELECT count(*) FROM scm.trips t WHERE t.driver_id = ${id})::int AS trips,
      (SELECT count(*) FROM scm.delivery_orders d WHERE d.driver_id = ${id})::int AS delivery_orders,
      (SELECT count(*) FROM scm.delivery_order_crew c WHERE c.driver_1_id = ${id} OR c.driver_2_id = ${id})::int AS crew,
      (SELECT count(*) FROM scm.orders o WHERE o.driver_id = ${id})::int AS orders,
      (SELECT count(*) FROM scm.consignment_delivery_orders c WHERE c.driver_id = ${id})::int AS consignment_dos,
      (SELECT count(*) FROM scm.driver_leave l WHERE l.driver_id = ${id})::int AS leave,
      (SELECT count(*) FROM scm.trip_locations tl WHERE tl.driver_id = ${id})::int AS trip_locations`;
  const row = r[0];
  const total = Object.values(row).reduce((a, b) => a + b, 0);
  return { total, row };
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const toDelete = [];
  for (const id of DELETE_IDS) {
    const rows = await sql`SELECT id, name, in_house, user_id, threepl_company_id FROM scm.drivers WHERE id = ${id}`;
    if (rows.length === 0) { note(`already gone: ${id}`); continue; }
    const d = rows[0];
    const name = String(d.name ?? "").trim().toLowerCase();
    if (d.in_house !== false) { bad(`refuse ${id} (${d.name}): in_house is not false — not an outsource row`); process.exit(3); }
    if (!EXPECTED_NAMES.has(name)) { bad(`refuse ${id}: name "${d.name}" is not one of JAN/SHAKTI/Cheah`); process.exit(3); }
    const refs = await referencesFor(sql, id);
    if (refs.total > 0) { bad(`refuse ${id} (${d.name}): now referenced ${JSON.stringify(refs.row)} — aborting, nothing written`); process.exit(3); }
    note(`will DELETE ${id} (${d.name}, in_house=${d.in_house}, user_id=${d.user_id ?? "null"}, company=${d.threepl_company_id ?? "null"}, refs=0)`);
    toDelete.push(id);
  }

  const toUnlink = [];
  for (const id of UNLINK_IDS) {
    const rows = await sql`SELECT id, name, user_id FROM scm.drivers WHERE id = ${id}`;
    if (rows.length === 0) { bad(`survivor ${id} to unlink is MISSING — aborting`); process.exit(3); }
    if (rows[0].user_id == null) { note(`already unlinked: ${id} (${rows[0].name})`); continue; }
    note(`will CLEAR user_id ${rows[0].user_id} on ${id} (${rows[0].name})`);
    toUnlink.push(id);
  }

  for (const id of SURVIVOR_IDS) {
    const rows = await sql`SELECT id, name FROM scm.drivers WHERE id = ${id}`;
    if (rows.length === 0) { bad(`survivor ${id} is MISSING — aborting`); process.exit(3); }
    note(`keep ${id} (${rows[0].name})`);
  }

  if (!APPLY) {
    note(`PLAN: would delete ${toDelete.length} row(s), clear ${toUnlink.length} user link(s). Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  if (toDelete.length === 0 && toUnlink.length === 0) {
    note("nothing to do — already deduped.");
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    for (const id of toDelete) {
      const refs = await referencesFor(tx, id); // fresh re-check inside the txn
      if (refs.total > 0) throw new Error(`row ${id} became referenced mid-run: ${JSON.stringify(refs.row)}`);
      await tx`DELETE FROM scm.drivers WHERE id = ${id}`;
    }
    for (const id of toUnlink) {
      await tx`UPDATE scm.drivers SET user_id = NULL WHERE id = ${id}`;
    }
  });
  note(`APPLIED: deleted ${toDelete.length}, unlinked ${toUnlink.length}.`);
  await sql.end();

  // Verify on a FRESH connection: shape, not just counts.
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const gone = await check`SELECT id FROM scm.drivers WHERE id IN ${check(DELETE_IDS)}`;
    if (gone.length > 0) { bad(`VERIFY FAILED: ${gone.length} target row(s) still present`); process.exit(4); }
    const survivors = await check`SELECT id, name, user_id FROM scm.drivers WHERE id IN ${check(SURVIVOR_IDS)}`;
    if (survivors.length !== SURVIVOR_IDS.length) { bad(`VERIFY FAILED: expected ${SURVIVOR_IDS.length} survivors, found ${survivors.length}`); process.exit(4); }
    const cheah = survivors.find((s) => s.id === "872736b3-4218-466b-a581-377efd3b46d3");
    if (cheah && cheah.user_id != null) { bad(`VERIFY FAILED: Cheah's survivor still links user_id ${cheah.user_id}`); process.exit(4); }
    const dupes = await check`
      SELECT lower(name) AS n, count(*)::int AS c FROM scm.drivers
      WHERE in_house = false AND lower(name) IN ('jan','shakti','cheah')
      GROUP BY 1 HAVING count(*) > 1`;
    if (dupes.length > 0) { bad(`VERIFY: an outsource name still has duplicates: ${JSON.stringify(dupes)}`); process.exit(4); }
    note("VERIFIED ON A FRESH CONNECTION: targets gone, one outsource row per person, Cheah unlinked.");
  } finally {
    await check.end();
  }
}

main().catch((e) => { bad(String(e?.message ?? e)); process.exit(1); });
