#!/usr/bin/env node
/* delete-duplicate-driver-rows.mjs — remove seven junk rows from scm.drivers.

   WHY. The fleet master was seeded twice. Every real in-house driver kept a
   proper full-name row (DRV-00x, a login, in_house) AND a short "simeng" row
   from an earlier bulk import (DRV-0x, no login). The short rows clutter the
   dispatcher's driver picker, and one of them — "Shamsul Fiqri" DRV-09 — is
   still ACTIVE and mis-flagged non-in-house, so it reads as a second, empty
   Shamsul. A live "Test Driver" and an old "QA TEST DRIVER" are in there too.
   The owner confirmed on 2026-10-20: keep the five in-house rows, drop these.

   WHAT IS REMOVED (by exact id, each re-identified by name before it goes):
     Khalid        DRV-02   (dup of ABD KHALID BIN TA ARIF)
     Faslie        DRV-01   (dup of FASLIE ANAK DENNIS)
     Farhan        DRV-04   (dup of UMAR FARHAN BIN MD YUSOF)
     Yunus         DRV-03   (former driver, inactive — owner: delete)
     Shamsul Fiqri DRV-09   (active dup of Shamsul fiqri bin samsuddin)
     Test Driver   DRV-015  (test account; its login in auth stays, cleared separately)
     QA TEST DRIVER DRV-QA1 (2990 test account)

   The five KEPT in-house rows (ABD KHALID, FASLIE ANAK DENNIS, UMAR FARHAN,
   MOHD ZAIMIR, Shamsul fiqri bin samsuddin) and the outsourced 3PL roster are
   never named here, so nothing can touch them.

   SAFETY. Eight columns reference scm.drivers (consignment_delivery_orders,
   delivery_order_crew x2, delivery_orders, driver_leave, orders, trip_locations,
   trips). The script reads that FK list from the catalogue at run time and
   REFUSES to delete any id that something still references, so a row that gains
   a delivery or a trip after this was written is left alone and reported, never
   orphaned. A row whose current name no longer matches the expected one is also
   refused — a uuid that was reused is not the row we reviewed.

   MODE=plan (default) reads and reports every target and writes nothing.
   MODE=apply needs CONFIRM="DELETE DUPLICATE DRIVER ROWS", deletes the clean
   targets inside one transaction, and verifies on a FRESH connection that each
   is gone by re-reading it by id and name.

   RE-RUN: inert. Deletes are keyed on exact ids that no longer exist after the
   first apply, so a second run re-reads them, finds each already gone, and
   reports zero to delete without writing anything. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'DELETE DUPLICATE DRIVER ROWS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* Each target carries the name and code we reviewed, so a delete only lands on
   a row that still IS that row. `match` is a lowercased substring of the name. */
const TARGETS = [
  { id: '994c9c46-3fd9-4935-85a6-d252b7b3cd67', code: 'DRV-02',  match: 'khalid',        label: 'Khalid (dup)' },
  { id: '6ae54ad0-4695-4d36-9d2e-de971a45a6c0', code: 'DRV-01',  match: 'faslie',        label: 'Faslie (dup)' },
  { id: 'c8741428-635c-4ac7-a1bf-8039c7e9c919', code: 'DRV-04',  match: 'farhan',        label: 'Farhan (dup)' },
  { id: 'b5300229-e840-46de-bbf2-98630a13f894', code: 'DRV-03',  match: 'yunus',         label: 'Yunus (former)' },
  { id: '4c759799-d335-4da1-b8ba-02987c88c07f', code: 'DRV-09',  match: 'shamsul fiqri', label: 'Shamsul Fiqri (dup)' },
  { id: 'b1268c26-1a4b-49df-8982-8bc9b6263501', code: 'DRV-015', match: 'test driver',   label: 'Test Driver' },
  { id: '1d1182ff-2832-4c27-85d2-95d15a2d2c3d', code: 'DRV-QA1', match: 'qa test',       label: 'QA TEST DRIVER' },
];
const IDS = TARGETS.map((t) => t.id);

/** The columns in scm that are a FOREIGN KEY onto scm.drivers, read from the
 *  catalogue so a reference added after today is still counted. */
async function driverFkColumns(client) {
  const rows = await client`
    SELECT kcu.table_schema AS schema, kcu.table_name AS table, kcu.column_name AS column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_schema = 'scm' AND ccu.table_name = 'drivers' AND ccu.column_name = 'id'`;
  return rows.map((r) => ({ t: `${r.schema}.${r.table}`, c: r.column }));
}

/** id -> how many rows across all FK columns point at it. */
async function countRefs(client, fks, ids) {
  const refs = new Map(ids.map((id) => [id, 0]));
  for (const fk of fks) {
    const rows = await client.unsafe(
      `SELECT ${fk.c}::text AS id, COUNT(*)::int AS n FROM ${fk.t}
        WHERE ${fk.c} = ANY($1::uuid[]) GROUP BY ${fk.c}`, [ids]);
    for (const r of rows) refs.set(r.id, (refs.get(r.id) || 0) + r.n);
  }
  return refs;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  const fks = await driverFkColumns(sql);
  note(`\n=== FK columns that reference scm.drivers (${fks.length}) ===`);
  for (const fk of fks) note(`  ${fk.t}.${fk.c}`);

  const present = await sql`
    SELECT id::text AS id, name, driver_code, active, in_house,
           (user_id IS NOT NULL) AS has_login, company_id
      FROM scm.drivers WHERE id = ANY(${IDS}::uuid[])`;
  const byId = new Map(present.map((r) => [r.id, r]));
  const refs = await countRefs(sql, fks, IDS);

  const deletable = [];
  const refused = [];
  const gone = [];

  note(`\n=== TARGETS ===`);
  for (const t of TARGETS) {
    const row = byId.get(t.id);
    if (!row) { gone.push(t); note(`  GONE   ${t.label} ${t.code} — not in the table (already removed)`); continue; }
    const nameOk = String(row.name).toLowerCase().includes(t.match);
    const r = refs.get(t.id) || 0;
    const facts = `name="${row.name}" code=${row.driver_code} active=${row.active} in_house=${row.in_house} login=${row.has_login} co=${row.company_id} refs=${r}`;
    if (!nameOk) { refused.push({ t, why: `name "${row.name}" no longer matches "${t.match}" — not the row reviewed` }); bad(`  REFUSE ${t.label} ${t.code} — ${facts}`); continue; }
    if (r > 0) { refused.push({ t, why: `${r} document/trip reference(s) still point at it` }); bad(`  REFUSE ${t.label} ${t.code} — ${facts}`); continue; }
    deletable.push({ t, row });
    note(`  DELETE ${t.label} ${t.code} — ${facts}`);
  }
  note(`\n  deletable: ${deletable.length}   refused: ${refused.length}   already gone: ${gone.length}`);
  for (const x of refused) bad(`  will NOT delete ${x.t.label} ${x.t.code}: ${x.why}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (!deletable.length) {
    note(`\nNothing to delete.`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== DELETING ${deletable.length} ROW(S) ===`);
  let wrote = 0;
  await sql.begin(async (tx) => {
    /* Re-assert zero references INSIDE the transaction: a delivery or trip
       assigned between the plan and this apply must abort the whole batch,
       never leave a dangling reference. */
    const live = await countRefs(tx, fks, deletable.map((d) => d.t.id));
    for (const d of deletable) {
      if ((live.get(d.t.id) || 0) > 0) throw new Error(`${d.t.label} ${d.t.code} gained a reference — aborting the whole batch`);
    }
    for (const d of deletable) {
      const back = await tx`
        DELETE FROM scm.drivers
         WHERE id = ${d.t.id} AND lower(name) LIKE ${'%' + d.t.match + '%'}
        RETURNING id::text AS id`;
      wrote += back.length;
      note(`  ${back.length ? 'OK  ' : 'SKIP'} ${d.t.label} ${d.t.code}`);
    }
  });
  note(`  deleted: ${wrote} of ${deletable.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const survivors = await check`
      SELECT id::text AS id, name, driver_code FROM scm.drivers WHERE id = ANY(${IDS}::uuid[])`;
    const survivorIds = new Set(survivors.map((s) => s.id));
    const stillThere = deletable.filter((d) => survivorIds.has(d.t.id));
    for (const s of survivors) note(`  remaining: ${JSON.stringify(s)}`);
    if (stillThere.length) {
      for (const d of stillThere) bad(`  ${d.t.label} ${d.t.code} was NOT removed`);
      throw new Error(`${stillThere.length} target(s) still present after delete`);
    }
    const leftoverRefs = await countRefs(check, fks, deletable.map((d) => d.t.id));
    const dangling = [...leftoverRefs.entries()].filter(([, n]) => n > 0);
    note(`  deleted ids now absent: ${deletable.length}/${deletable.length}; dangling references: ${dangling.length}`);
    if (dangling.length) throw new Error(`dangling references remain: ${JSON.stringify(dangling)}`);
    note(`  five kept in-house drivers and the 3PL roster were never targeted.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
