#!/usr/bin/env node
/* Fold addresses into the two-line shape (owner 2026-11-18: every address form
   shows Address line 1, Address line 2, then Postcode / City / State, like the
   Sales Order). The forms already show lines 3 / 4 inside line 2, so this is
   tidying, not a fix a screen waits for.

   WHAT IT DOES, per row (scripts/lib/fold-address-lines.mjs decides, pure and
   tested):
     - LINES 3 / 4: a part that names a postcode / city / state my_localities
       knows ("11900 Bayan Lepas", "Penang") fills the record's postcode / city
       / state ONLY where that field is empty; one that disagrees with a filled
       field is a CONFLICT: the row is left exactly as it is and listed; the
       remaining free text is appended to line 2 (", " joined) so nothing is
       lost; then lines 3 / 4 are set to NULL.
     - A STREET IN STATE (production: suppliers whose State holds "1831-B JALAN
       KPB1, ..."): a State that is no Malaysian state and has a digit or a
       comma moves into the address lines (unless they already hold it) and the
       State is cleared;
     - then an empty City / State is filled from the postcode with
       complete-postcode-fields.mjs's own rule (lib/postcode-completion.mjs).
   The address3 / address4 COLUMNS stay: prints, the AutoCount write-back
   (soInvoiceAddress: line 3 = postcode + city, line 4 = state when 3 / 4 are
   empty) and old imports read them.

   TABLES (TABLES=assr,dp,supplier,debtor,so; default assr,dp,supplier,debtor):
     assr      public.assr_cases addr1..addr4 + public.assr_case_address
     dp        scm.dp_orders address1..4 + postcode / city / state
     supplier  scm.suppliers address1..4 + postcode / city / state (its billing
               `address` counts as "already holds it" for a street in State)
     debtor    scm.acc_debtors address1..4 + postcode / city / state
     so        scm.mfg_sales_orders address1..4 + postcode / city / customer_state.
               Only when named: a customer document mirrored to AutoCount. Lines
               kept within the account book's 40 characters (else too_long, left
               alone: those lines are the save fit's spill); a cancelled order or
               one a live Delivery Order / Sales Invoice carries is LOCKED (the
               lock complete-postcode-fields.mjs uses), listed and never written,
               re-checked inside the UPDATE. AutoCount is not updated here.
   A table missing any column is skipped and said so (never a phantom column).

   COMPANY SCOPE: COMPANY_ID=<id> is REQUIRED; reads and writes are that
   company's rows only (assr_case_address via its case's company), and every
   UPDATE is keyed on the row's id AND company_id.

   PUBLIC LOG. Customer addresses are personal data and Actions logs are kept:
   only table, row key, action and the NAMES of the fields that change print —
   never an address.

   MODE=plan (default) prints the decision for every row and writes nothing.
   MODE=apply needs CONFIRM="FOLD ADDRESS LINES AS PLANNED". Each row is written
   in one transaction, guarded on every address column it read still holding
   what was read (a row edited meanwhile is skipped). Every written row is
   re-read on a FRESH connection and its SHAPE checked: lines 3 / 4 empty, no
   street left in State, each planned field holding its planned value.

   Optional LIMIT=<n> caps the rows read per table.

   RE-RUN: safe. A folded row has empty lines 3 / 4 and a real State and drops
   out; a conflict, too_long or locked row is listed again until a person or
   its lock clears it. */
import postgres from 'postgres';
import { foldAddressRow, indexLocalities, isStreetInState } from './lib/fold-address-lines.mjs';
import { LOCK_SQL } from './lib/postcode-completion.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (!Number.isInteger(CO) || CO <= 0) { console.error('COMPANY_ID is required (a positive integer); run once per company'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'FOLD ADDRESS LINES AS PLANNED';
const LIMIT = Math.max(1, Math.min(200000, Number(process.env.LIMIT || 200000)));

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* Per table: where the lines and the town live. `town` set = another table. */
const TABLES = [
  { key: 'assr', label: 'service cases', table: 'public.assr_cases', id: 'id', idCast: 'bigint',
    lines: ['addr1', 'addr2', 'addr3', 'addr4'], maxLine: null, lock: null, haystack: null,
    town: { table: 'public.assr_case_address', fk: 'assr_id' }, cols: { postcode: 'postcode', city: 'city', state: 'state' } },
  { key: 'dp', label: 'DP orders', table: 'scm.dp_orders', id: 'id', idCast: 'uuid',
    lines: ['address1', 'address2', 'address3', 'address4'], maxLine: null, lock: null, haystack: null,
    town: null, cols: { postcode: 'postcode', city: 'city', state: 'state' } },
  { key: 'supplier', label: 'suppliers', table: 'scm.suppliers', id: 'id', idCast: 'uuid',
    lines: ['address1', 'address2', 'address3', 'address4'], maxLine: null, lock: null, haystack: 'address',
    town: null, cols: { postcode: 'postcode', city: 'city', state: 'state' } },
  { key: 'debtor', label: 'other debtors', table: 'scm.acc_debtors', id: 'id', idCast: 'uuid',
    lines: ['address1', 'address2', 'address3', 'address4'], maxLine: null, lock: null, haystack: null,
    town: null, cols: { postcode: 'postcode', city: 'city', state: 'state' } },
  { key: 'so', label: 'sales orders', table: 'scm.mfg_sales_orders', id: 'doc_no', idCast: 'text',
    lines: ['address1', 'address2', 'address3', 'address4'], maxLine: 40, lock: 'so', haystack: null,
    town: null, cols: { postcode: 'postcode', city: 'city', state: 'customer_state' } },
];
const DEFAULT_KEYS = ['assr', 'dp', 'supplier', 'debtor'];
const PICK = (process.env.TABLES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const unknown = PICK.filter((k) => !TABLES.some((t) => t.key === k));
if (unknown.length) { console.error(`unknown TABLES value(s) ${unknown.join(', ')}; use ${TABLES.map((t) => t.key).join(', ')}`); process.exit(2); }
const RUN = TABLES.filter((t) => (PICK.length ? PICK : DEFAULT_KEYS).includes(t.key));

const FIELD_OF = (t) => ({ line1: t.lines[0], line2: t.lines[1], line3: t.lines[2], line4: t.lines[3], ...t.cols });
const townRef = (t, f) => (t.town ? `a.${t.cols[f]}` : `x.${t.cols[f]}`);
const nonState = (col) => `(${col} ~ '[0-9,]')`;

async function missingColumns(sql, t) {
  const cols = async (qualified) => {
    const [schema, table] = qualified.split('.');
    const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`;
    return new Set(rows.map((r) => r.column_name));
  };
  const own = await cols(t.table);
  const want = [t.id, 'company_id', ...t.lines, ...(t.haystack ? [t.haystack] : []), ...(t.town ? [] : Object.values(t.cols)), ...(t.lock ? ['status'] : [])];
  const missing = want.filter((c) => !own.has(c));
  if (t.town) {
    const other = await cols(t.town.table);
    missing.push(...[t.town.fk, 'postcode', 'city', 'state', 'updated_at'].filter((c) => !other.has(c)).map((c) => `${t.town.table}.${c}`));
  }
  return missing;
}

function selectSql(t, where) {
  const [l1, l2, l3, l4] = t.lines;
  return `SELECT x.${t.id}::text AS id, x.company_id, x.${l1} AS line1, x.${l2} AS line2, x.${l3} AS line3, x.${l4} AS line4,
                 ${townRef(t, 'postcode')} AS postcode, ${townRef(t, 'city')} AS city, ${townRef(t, 'state')} AS state,
                 ${t.town ? '(a.assr_id IS NOT NULL) AS town_row' : 'NULL::boolean AS town_row'},
                 ${t.haystack ? `x.${t.haystack}` : 'NULL::text'} AS haystack,
                 ${t.lock ? `(${LOCK_SQL[t.lock]})` : 'NULL::text'} AS locked
            FROM ${t.table} x
            ${t.town ? `LEFT JOIN ${t.town.table} a ON a.${t.town.fk} = x.${t.id}` : ''}
           WHERE x.company_id = $1 AND ${where}`;
}

const candidates = (t) => {
  const [, , l3, l4] = t.lines;
  return `(x.${l3} IS NOT NULL OR x.${l4} IS NOT NULL OR ${nonState(townRef(t, 'state'))}) ORDER BY x.${t.id} LIMIT ${LIMIT}`;
};

/* Guarded write of one row: every column read must still hold what was read. */
async function writeRow(sql, t, r, d) {
  return sql.begin(async (tx) => {
    const params = [r.id, CO];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const eq = (col, v) => `${col} IS NOT DISTINCT FROM ${p(v)}`;
    const fields = FIELD_OF(t);
    const lineSets = d.changed.filter((f) => f.startsWith('line')).map((f) => `${fields[f]} = ${p(d.next[f])}`);
    const townSets = t.town ? [] : d.changed.filter((f) => !f.startsWith('line')).map((f) => `${fields[f]} = ${p(d.next[f])}`);
    const guards = [
      ...t.lines.map((c, i) => eq(c, r[`line${i + 1}`])),
      ...(t.town ? [] : ['postcode', 'city', 'state'].map((f) => eq(t.cols[f], r[f]))),
    ];
    const sets = [...lineSets, ...townSets];
    if (sets.length) {
      const done = await tx.unsafe(
        `UPDATE ${t.table} x SET ${sets.join(', ')}
          WHERE x.${t.id} = $1::${t.idCast} AND x.company_id = $2 AND ${guards.join(' AND ')}
                ${t.lock ? `AND (${LOCK_SQL[t.lock]}) IS NULL` : ''}
          RETURNING x.${t.id}::text AS id`, params);
      if (done.length !== 1) throw new Error('SKIP');
    }
    const townChanged = ['postcode', 'city', 'state'].filter((f) => d.changed.includes(f));
    if (t.town && townChanged.length) {
      const q = [r.id, d.next.postcode, d.next.city, d.next.state, r.postcode, r.city, r.state];
      const done = r.town_row
        ? await tx.unsafe(
          `UPDATE ${t.town.table} SET postcode = $2, city = $3, state = $4, updated_at = now()
            WHERE ${t.town.fk} = $1::${t.idCast} AND postcode IS NOT DISTINCT FROM $5 AND city IS NOT DISTINCT FROM $6 AND state IS NOT DISTINCT FROM $7
              AND EXISTS (SELECT 1 FROM ${t.table} c WHERE c.${t.id} = $1::${t.idCast} AND c.company_id = ${CO})
            RETURNING ${t.town.fk}`, q)
        : await tx.unsafe(
          `INSERT INTO ${t.town.table} (${t.town.fk}, postcode, city, state)
           SELECT $1::${t.idCast}, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM ${t.table} c WHERE c.${t.id} = $1::${t.idCast} AND c.company_id = ${CO})
           ON CONFLICT (${t.town.fk}) DO NOTHING RETURNING ${t.town.fk}`, q.slice(0, 4));
      if (done.length !== 1) throw new Error('SKIP');
    }
    return true;
  }).catch((e) => { if (e.message === 'SKIP') return false; throw e; });
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} limit=${LIMIT} tables=${RUN.map((t) => t.key).join(',')}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failed = 0;
  try {
    const loc = indexLocalities(await sql`SELECT postcode, city, state FROM scm.my_localities`);
    note(`my_localities: ${loc.idx.size} postcodes`);
    const results = [];
    for (const t of RUN) {
      const missing = await missingColumns(sql, t);
      if (missing.length) { bad(`${t.label}: SKIPPED — no column ${missing.join(', ')}`); continue; }
      const rows = await sql.unsafe(selectSql(t, candidates(t)), [CO]);
      const by = { fold: [], locked: [], conflict: [], too_long: [], none: [] };
      for (const r of rows) {
        const d = foldAddressRow(r, loc, t.maxLine);
        if (d.action === 'fold' && r.locked) by.locked.push({ r, d });
        else by[d.action].push({ r, d });
      }
      const names = (d) => d.changed.map((f) => FIELD_OF(t)[f]).join(', ');
      note(`\n=== ${t.label.toUpperCase()} (${t.table}): ${rows.length} row(s) with text in line 3 / 4 or a street in State ===`);
      for (const { r, d } of by.fold) note(`  FOLD      ${t.key} ${r.id}: ${names(d)}${d.notes.length ? ` (${d.notes.join('; ')})` : ''}`);
      for (const { r, d } of by.locked) note(`  LOCKED    ${t.key} ${r.id}: would change ${names(d)}; ${r.locked}`);
      for (const { r, d } of by.conflict) note(`  CONFLICT  ${t.key} ${r.id}: ${d.why}`);
      for (const { r, d } of by.too_long) note(`  TOO LONG  ${t.key} ${r.id}: ${d.why}`);
      note(`  fold: ${by.fold.length}   locked: ${by.locked.length}   conflict: ${by.conflict.length}   too_long: ${by.too_long.length}   nothing to do: ${by.none.length}`);
      results.push({ t, by });
    }

    if (!APPLY) {
      note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
      return;
    }

    const writtenBy = [];
    for (const { t, by } of results) {
      note(`\n=== FOLDING ${by.fold.length} ${t.label.toUpperCase()} ===`);
      const written = [];
      for (const x of by.fold) {
        if (await writeRow(sql, t, x.r, x.d)) written.push(x);
        else note(`  SKIP (edited or locked meanwhile) ${t.key} ${x.r.id}`);
      }
      note(`  written: ${written.length} of ${by.fold.length}`);
      writtenBy.push({ t, written });
    }
    await sql.end({ timeout: 5 });

    const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
    try {
      note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
      for (const { t, written } of writtenBy) {
        let wrong = 0;
        for (const { r, d } of written) {
          const [row] = await check.unsafe(selectSql(t, `x.${t.id} = $2::${t.idCast}`), [CO, r.id]);
          const empty = (v) => v == null || String(v).trim() === '';
          const ok = row && empty(row.line3) && empty(row.line4) && !isStreetInState(row.state)
            && d.changed.every((f) => (row[f] ?? null) === (d.next[f] ?? null));
          if (!ok) { wrong += 1; bad(`  ${t.key} ${r.id}: did not read back in the two-line shape as planned`); }
        }
        note(`  ${t.label}: ${written.length - wrong} of ${written.length} written row(s) read back as planned`);
        failed += wrong;
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  bad(e.message);
  process.exit(1);
});
