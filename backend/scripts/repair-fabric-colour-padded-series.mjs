#!/usr/bin/env node
// repair-fabric-colour-padded-series — three fabric colours sit on a library row
// whose id is the same code with a trailing space, while the clean row exists
// beside it.
//
// WHAT IS WRONG, measured on production 2026-09-11 (company 1). `fabric_library`
// holds exactly two ids that differ from themselves trimmed, and BOTH have a
// trimmed twin present:
//
//   `TARONI `    active,   2 colours   <- `TARONI`   active, 13 colours
//   `GARFIELD `  RETIRED,  1 colour    <- `GARFIELD` active
//
// and the retired one says what happened in its own label:
//   "GARFIELD  [MERGED into GARFIELD on 2026-08-11 - superseded, not deleted]"
//
// So somebody already merged that series on 2026-08-11 and marked the old row
// superseded — and left its one colour, `GARFIELD-03`, pointing at the dead row.
// This finishes that merge, and does the same for TARONI's split.
//
// WHY IT MATTERS NOW, and not as tidying. `GET /fabric-colours` began hiding
// colours whose SERIES is switched off (owner 2026-09-11:「inactive的就不需要了」),
// so `GARFIELD-03` — a live shade of a live fabric — would disappear from the
// picker purely because of a trailing space. The repair and that filter belong
// in the same change.
//
// SCOPE, and why it is written as a RULE rather than three ids: a colour whose
// `fabric_id` differs from `btrim(fabric_id)` while a library row exists at the
// trimmed id. Anything else is left alone — a padded id with NO clean twin is
// not a duplicate, it is that fabric's only row, and moving it would invent a
// series.
//
// REFUSES rather than guesses: if the target (trimmed_id, colour_id) ALREADY
// exists, the two rows are a real duplicate and which one wins is a catalogue
// decision, not a repair's. Reported and skipped.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="FABRIC-PADDED-SERIES".
// RE-RUN: idempotent. After a successful apply no colour sits on a padded id
// that has a twin, so a second run finds nothing; the fresh-connection check
// below asserts that SHAPE rather than a row count.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "FABRIC-PADDED-SERIES";

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

/** Colours whose series id carries padding AND whose trimmed twin exists. */
const FIND = `
  SELECT c.company_id, c.fabric_id AS padded, btrim(c.fabric_id) AS clean, c.colour_id,
         l.active AS padded_active,
         EXISTS (SELECT 1 FROM scm.fabric_colours d
                  WHERE d.company_id = c.company_id
                    AND d.fabric_id = btrim(c.fabric_id)
                    AND d.colour_id = c.colour_id) AS target_taken
    FROM scm.fabric_colours c
    JOIN scm.fabric_library l ON l.id = c.fabric_id AND l.company_id = c.company_id
   WHERE c.fabric_id <> btrim(c.fabric_id)
     AND EXISTS (SELECT 1 FROM scm.fabric_library t
                  WHERE t.company_id = c.company_id AND t.id = btrim(c.fabric_id))
   ORDER BY c.company_id, c.fabric_id, c.colour_id`;

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const rows = await sql.unsafe(FIND);
  const move = rows.filter((r) => !r.target_taken);
  const refused = rows.filter((r) => r.target_taken);

  log(`Colours on a padded series id that has a clean twin: ${rows.length}`);
  for (const r of move) {
    log(`   company ${r.company_id}  ${r.colour_id}: ${JSON.stringify(r.padded)} -> ${JSON.stringify(r.clean)}`
      + `  (the padded row is ${r.padded_active ? "active" : "RETIRED"})`);
  }
  if (refused.length) {
    log(`\nREFUSED — the clean row already holds that colour, so which wins is a catalogue decision: ${refused.length}`);
    for (const r of refused) log(`   ${r.colour_id} on ${JSON.stringify(r.padded)}`);
  }

  if (MODE !== "apply") {
    log(`\nPLAN: nothing written. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); }
  if (move.length === 0) { log("Nothing to move."); await sql.end(); return; }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const r of move) {
      /* fabric_id is part of the PK, so this moves the row. The FK to
         fabric_library(id) is satisfied because the clean row is what the WHERE
         above proved exists. */
      await tx`UPDATE scm.fabric_colours
                  SET fabric_id = ${r.clean}
                WHERE company_id = ${r.company_id}
                  AND fabric_id = ${r.padded}
                  AND colour_id = ${r.colour_id}`;
      n++;
    }
  });
  log(`\nAPPLIED: ${n} colour(s) moved onto the clean series row.`);
  await sql.end();

  /* Verify on a FRESH connection, asserting the SHAPE: no colour is left on a
     padded series that has a twin. A count of updates would be true even if the
     rows had landed on the wrong series. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const left = await v.unsafe(FIND);
  const stillMovable = left.filter((r) => !r.target_taken);
  const placed = await v`
    SELECT count(*)::int AS n FROM scm.fabric_colours c
     WHERE c.company_id = ANY(${[...new Set(move.map((r) => r.company_id))]})
       AND c.colour_id = ANY(${move.map((r) => r.colour_id)})
       AND c.fabric_id = btrim(c.fabric_id)`;
  await v.end();
  if (stillMovable.length) die(`VERIFY FAILED: ${stillMovable.length} colour(s) still sit on a padded series with a twin`);
  if (placed[0].n < move.length) die(`VERIFY FAILED: only ${placed[0].n} of ${move.length} moved colours are on a trimmed series id`);
  log(`VERIFIED on a fresh connection: all ${move.length} now sit on a trimmed series id, and none remains on a padded one.`);
}

main().catch((e) => die(e?.message ?? String(e)));
