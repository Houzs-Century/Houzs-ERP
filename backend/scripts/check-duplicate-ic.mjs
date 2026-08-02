#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-duplicate-ic.mjs — READ-ONLY. Which drivers or helpers share an IC?
//
// WHY. We want a UNIQUE index on ic_number so one identity document cannot be
// registered twice. It cannot simply be added: if the live data ALREADY holds
// duplicates the index fails to build, and in this repo a failing migration
// blocks every LATER migration until someone fixes it (CLAUDE.md records two
// incidents of exactly that, one of which left the backend un-deployed for two
// hours). So the data gets checked first, by a human reading a list.
//
// There is concrete reason to expect duplicates: the live driver roster carries
// "Shakti" three times (DRV-002 / DRV-05 / DRV-050, all on one phone number)
// and "Hua" twice. If those rows have an IC filled in, they collide.
//
// OWNER RULE (CLAUDE.md): "Never ask the owner to run a query — build the check
// instead." Hence a script plus a workflow_dispatch, not a SQL snippet pasted
// into chat. The verdict appears as a run annotation.
//
// READ-ONLY MEANS READ-ONLY. Two SELECTs. No DDL, no writes, no transaction.
// EXIT 0 FOR EVERY LEGITIMATE ANSWER — "there are duplicates" is an ANSWER, not
// a failure. A red job reads as "the check broke". Non-zero is reserved for an
// unreachable database.
//
//   DATABASE_URL=... node backend/scripts/check-duplicate-ic.mjs
// ---------------------------------------------------------------------------

import pg from 'pg';

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error('DATABASE_URL is not set. This script reads production; it cannot guess the DSN.');
  process.exit(1);
}

/** Normalise the way the app now does (scm/lib/fleet-crew-fields.ts), so
 *  "900101-01-5523" and "900101015523" count as the SAME identity — otherwise
 *  the check would report clean and the index would still fail. */
const norm = (s) => {
  const t = String(s ?? '').trim();
  const digits = t.replace(/\D+/g, '');
  if (digits.length === 12 && digits === t.replace(/[-\s]/g, '')) {
    return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
  }
  return t.toUpperCase();
};

const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
} catch (err) {
  console.error(`Could not reach the database: ${err.message}`);
  process.exit(1);
}

try {
  const drivers = await client.query(
    `SELECT id, driver_code, name, phone, ic_number, active
       FROM scm.drivers
      WHERE ic_number IS NOT NULL AND btrim(ic_number) <> ''`,
  );
  const helpers = await client.query(
    `SELECT id, helper_code, name, contact, ic_number, active
       FROM scm.helpers
      WHERE ic_number IS NOT NULL AND btrim(ic_number) <> ''`,
  );

  const report = (label, rows, codeCol, phoneCol) => {
    const byIc = new Map();
    for (const r of rows) {
      const key = norm(r.ic_number);
      if (!byIc.has(key)) byIc.set(key, []);
      byIc.get(key).push(r);
    }
    const dupes = [...byIc.entries()].filter(([, list]) => list.length > 1);

    console.log(`\n=== ${label} ===`);
    console.log(`${rows.length} row(s) carry an IC; ${byIc.size} distinct after normalisation.`);
    if (dupes.length === 0) {
      console.log('No duplicates. A UNIQUE index on ic_number would build cleanly.');
      return 0;
    }
    console.log(`${dupes.length} IC value(s) are used more than once — a UNIQUE index would FAIL to build:\n`);
    for (const [ic, list] of dupes.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  IC ${ic} — ${list.length} rows:`);
      for (const r of list) {
        const bits = [r[codeCol] ?? '(no code)', r.name ?? '(no name)', r[phoneCol] ?? '(no phone)', r.active === false ? 'INACTIVE' : 'active'];
        console.log(`    - ${bits.join('  ·  ')}   [as typed: ${r.ic_number}]`);
      }
    }
    return dupes.length;
  };

  const d = report('scm.drivers', drivers.rows, 'driver_code', 'phone');
  const h = report('scm.helpers', helpers.rows, 'helper_code', 'contact');

  console.log('\n---');
  if (d + h === 0) {
    console.log('CLEAN — the unique index can be added.');
  } else {
    console.log(`${d + h} duplicated IC value(s) across drivers and helpers.`);
    console.log('For each: decide whether the rows are ONE person entered twice (merge, then');
    console.log('the index can go on) or genuinely different people with a mistyped IC (fix the');
    console.log('typo). Nothing here changes any data — that is a separate, deliberate step.');
  }
} catch (err) {
  console.error(`Query failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
