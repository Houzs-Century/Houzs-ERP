#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-driver-scope-link.mjs — is the per-driver delivery scope actually ON,
// or has it been failing open to "every driver sees the whole board"?
//
// THE QUESTION. `resolveDeliveryScope` (lib/deliveryScope.ts) narrows a
// restricted transportation caller to their OWN jobs by resolving their fleet
// identity through `scm.drivers.user_id` / `scm.helpers.user_id`:
//
//     sb.from("drivers").select("id").eq("user_id", Number(uid))
//     if (d?.error || h?.error) return SCOPE_ALL;      // <- fails OPEN
//
// The fail-open is DELIBERATE and says so at the line: "a mis-synced driver is
// never LESS visible than today". That is a defensible choice. What it also
// means is that if the column is ABSENT, every restricted driver silently keeps
// the entire delivery board and the feature is inert — with no error, no log
// that anyone reads, and no way to tell from the UI.
//
// WHY IT IS IN DOUBT. No migration in this repository creates it:
//   · `grep -rn "ALTER TABLE scm.drivers" migrations-pg/ | grep user_id` -> nothing
//   · the 2990 import snapshot's `CREATE TABLE "drivers"` has no such column
//   · mig 0066's header calls it "0060's scm.drivers.user_id", but 0060 in THIS
//     repo is product_model_photos_and_hero_meta.sql
//
// So it is either a prod-only column created outside the repo — which has
// precedent here, `uq_inv_mov_do_source` was exactly that — or it does not
// exist and the scoping has never once narrowed anybody.
//
// EITHER ANSWER IS ACTIONABLE, which is why this is worth a workflow:
//   PRESENT + linked rows   -> scoping is live; nothing to do
//   PRESENT + ZERO linked   -> the column exists and nothing populates it; the
//                              feature is inert and the fix is a backfill
//   ABSENT                  -> the feature has never run. Decide whether to add
//                              the column + backfill, or to drop the code
//
// The row COUNTS matter as much as the column: a column nothing writes to
// produces exactly the same fail-open as a missing one, and only one of those
// two is visible from the schema.
//
// CLAUDE.md's rule is that the owner is not a database console. This is the
// script half of that; the workflow half runs it on Actions with the DSN that
// already lives there.
//
// STRICTLY READ-ONLY. SELECTs against information_schema and two COUNTs. No
// DDL, no writes, no transaction. Exits 0 for every legitimate answer —
// including ABSENT, which is a real result and not a failure. Non-zero only
// when the database is unreachable.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });

try {
  console.log("=== Driver delivery-scope link — is the per-driver board actually scoped? ===\n");

  const cols = await sql`
    SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'scm'
       AND table_name IN ('drivers', 'helpers')
       AND column_name = 'user_id'
     ORDER BY table_name
  `;
  const has = (t) => cols.some((c) => c.table_name === t);

  for (const t of ["drivers", "helpers"]) {
    const c = cols.find((x) => x.table_name === t);
    console.log(
      c
        ? `scm.${t}.user_id   PRESENT  (${c.data_type}, ${c.is_nullable === "YES" ? "nullable" : "not null"})`
        : `scm.${t}.user_id   ABSENT`,
    );
  }

  /* The counts. A column that exists but is empty fails open exactly as a
     missing one does, and the schema alone cannot tell the two apart. */
  let linkedDrivers = null, totalDrivers = null, linkedHelpers = null, totalHelpers = null;
  if (has("drivers")) {
    const [r] = await sql`SELECT COUNT(*) AS total, COUNT(user_id) AS linked FROM scm.drivers`;
    totalDrivers = Number(r.total); linkedDrivers = Number(r.linked);
  }
  if (has("helpers")) {
    const [r] = await sql`SELECT COUNT(*) AS total, COUNT(user_id) AS linked FROM scm.helpers`;
    totalHelpers = Number(r.total); linkedHelpers = Number(r.linked);
  }
  if (totalDrivers != null) console.log(`\nscm.drivers   ${linkedDrivers} of ${totalDrivers} rows carry a user_id`);
  if (totalHelpers != null) console.log(`scm.helpers   ${linkedHelpers} of ${totalHelpers} rows carry a user_id`);

  console.log("\n=== VERDICT ===");
  if (!has("drivers") && !has("helpers")) {
    console.log("ABSENT on both. resolveDeliveryScope's identity lookup errors on every");
    console.log("call and returns SCOPE_ALL, so the per-driver narrowing HAS NEVER RUN:");
    console.log("every restricted transportation caller sees the whole delivery board.");
    console.log("That is the current behaviour and it is not a regression — but it is not");
    console.log("what the code reads like it does. Decide: add the column and backfill it,");
    console.log("or delete the scoping and stop implying a restriction that is not there.");
  } else if ((linkedDrivers ?? 0) === 0 && (linkedHelpers ?? 0) === 0) {
    console.log("PRESENT but EMPTY. Nothing populates the link, so every lookup returns");
    console.log("zero rows and resolveDeliveryScope falls to its 'no fleet identity ->");
    console.log("SCOPE_ALL' branch. Same visible outcome as absent; the fix is a backfill,");
    console.log("not a migration.");
  } else {
    console.log("LIVE. The link exists and is populated, so a restricted caller really is");
    console.log("narrowed to their own jobs. Any driver row with a NULL user_id is still");
    console.log("unscoped by the fail-open, so the gap between linked and total above is");
    console.log("the number of crew who currently see everything.");
  }
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
