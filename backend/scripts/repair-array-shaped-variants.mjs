#!/usr/bin/env node
/* A `variants` block that became a jsonb ARRAY. Find them, show them, unwrap
   them — and refuse anything whose original object cannot be recovered.

   THE SHAPE. docs/jsonb-double-encoding-coe.md records what happened three
   times on 2026-08-10: binding a PRE-SERIALIZED STRING to a jsonb parameter.
   The driver hands Postgres a json string, and a `variants || …` merge against
   a string produces an ARRAY instead of the object every reader expects. Every
   consumer then reads `variants->>'fabricCode'` as NULL, so the line has no
   fabric, no seat height and no leg — it is not "wrong", it is absent.

   HOW IT WAS FOUND. Not by a report. Every apply in the fabric family ends
   with arrayShapeCheck, and on 2026-08-13 three separate prod runs each ended
   with the same line: "SO: 7 variants block(s) of ARRAY shape". The count did
   not move between runs, which is what proves those runs did not cause it —
   and every repoint in lib/fabric-write.mjs carries
   `AND jsonb_typeof(i.variants) = 'object'` in its WHERE, so none of them can
   touch an array-shaped row in the first place. Seven rows have been sitting
   like this since August, invisible because nothing had ever counted them.

   THE RECONSTRUCTION, and its limit. Two damage shapes are recoverable:

     [ {...} ]      the object survived, wrapped in a one-element array.
     [ "{...}" ]    the object survived as a STRING inside a one-element array
                    — the double-encoding proper.

   Both are unwrapped back to the object. ANYTHING ELSE IS REFUSED and printed
   in full: more than one element, an element that is not an object and does
   not parse as one, an empty array. A variants block decides what gets built
   and what it costs; a plausible guess there is worse than a visible gap.

   MODE=plan (default) prints every row's actual content and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one row at a
   time, and verifies on a fresh connection that no array-shaped block remains
   on any arm.

   RE-RUN: inert. Keyed on jsonb_typeof(variants) = 'array', which the unwrap turns into 'object'. */
import postgres from 'postgres';
import { ARMS, arrayShapeCheck, skippedArms } from './lib/fabric-write.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** The object this array was before it was mangled, or null when it cannot be
 *  recovered without guessing. */
function unwrap(arr) {
  if (!Array.isArray(arr)) return { ok: false, why: 'not an array' };
  if (arr.length !== 1) return { ok: false, why: `${arr.length} elements — only a one-element wrap is recoverable` };
  const el = arr[0];
  if (el && typeof el === 'object' && !Array.isArray(el)) return { ok: true, obj: el, how: 'object wrapped in an array' };
  if (typeof el === 'string') {
    try {
      const parsed = JSON.parse(el);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, obj: parsed, how: 'json STRING inside an array — the double-encoding proper' };
      }
      return { ok: false, why: 'the string parses, but not to an object' };
    } catch { return { ok: false, why: 'the string is not JSON' }; }
  }
  return { ok: false, why: `element is a ${typeof el}` };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  note(`\n=== ARRAY-SHAPED variants, per arm ===`);
  const before = await arrayShapeCheck(sql, CO);
  for (const a of before) if (a.n) note(`  ${a.arm}: ${a.n}`);
  const total = before.reduce((s, a) => s + a.n, 0);
  note(`  total: ${total}`);
  for (const s of skippedArms()) note(`  SKIPPED ${s.kind} ${s.table} — ${s.why}`);
  if (!total) { note(`\nNothing to repair.`); await sql.end({ timeout: 5 }); return; }

  /* Read them WITH their identity, so a refused row can be opened by a human
     rather than described. The arm list is the shared one, so a table that
     gained a mangled row later is included without editing this file. */
  /* ASK WHICH COLUMNS EXIST. Not every arm carries item_code —
     inventory_movements does not — and a hard-coded select fails the WHOLE
     run on the first arm that lacks it, which is what happened on the first
     prod plan. The identity column is resolved per arm and degrades to NULL
     rather than taking the script down. */
  const cols = await sql`SELECT table_schema || '.' || table_name AS t, column_name
                           FROM information_schema.columns WHERE table_schema = 'scm'`;
  const has = new Map();
  for (const r of cols) {
    if (!has.has(r.t)) has.set(r.t, new Set());
    has.get(r.t).add(r.column_name);
  }
  const rows = [];
  for (const arm of ARMS) {
    const have = has.get(arm.t) ?? new Set();
    const idCol = ['item_code', 'sku_code', 'product_code'].find((cName) => have.has(cName));
    const r = await sql.unsafe(
      `SELECT i.id::text AS id, ${idCol ? `i.${idCol}` : 'NULL'} AS item_code, i.variants::text AS raw
         FROM ${arm.t} i
        WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'array'`, [CO]);
    for (const x of r) rows.push({ arm: arm.name, t: arm.t, ...x });
  }

  const fix = [], refuse = [];
  for (const r of rows) {
    let parsed;
    try { parsed = JSON.parse(r.raw); } catch { refuse.push({ ...r, why: 'variants is not valid JSON at all' }); continue; }
    const u = unwrap(parsed);
    if (u.ok) fix.push({ ...r, obj: u.obj, how: u.how });
    else refuse.push({ ...r, why: u.why });
  }

  note(`\n=== WHAT IS ACTUALLY IN THEM ===`);
  for (const r of fix) {
    note(`  ${r.arm} ${r.id} ${String(r.item_code ?? '-').padEnd(22)} RECOVERABLE (${r.how})`);
    note(`      now:  ${r.raw.slice(0, 220)}`);
    note(`      then: ${JSON.stringify(r.obj).slice(0, 220)}`);
  }
  for (const r of refuse) {
    bad(`  ${r.arm} ${r.id} ${String(r.item_code ?? '-').padEnd(22)} REFUSED — ${r.why}`);
    note(`      raw:  ${r.raw.slice(0, 300)}`);
  }
  note(`\n  recoverable: ${fix.length}   refused: ${refuse.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== REPAIRING ${fix.length} ROW(S) ===`);
  let wrote = 0;
  for (const r of fix) {
    /* to_jsonb($1::text)::jsonb would re-encode. The object is passed as TEXT
       and cast ONCE with ::jsonb, which is the same discipline the repoints
       use and the opposite of what caused this: no serializer runs over a
       value that is already a bound text parameter. The guard on
       jsonb_typeof keeps a concurrent fix from being overwritten. */
    const back = await sql.unsafe(
      `UPDATE ${r.t} SET variants = $2::jsonb
        WHERE id = $1 AND jsonb_typeof(variants) = 'array'
       RETURNING id::text AS id`, [r.id, JSON.stringify(r.obj)]);
    wrote += back.length;
    note(`  ${back.length ? 'OK ' : 'SKIP'} ${r.arm} ${r.id} ${r.item_code ?? '-'}`);
  }
  note(`  written: ${wrote} of ${fix.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const after = await arrayShapeCheck(check, CO);
    const left = after.reduce((s, a) => s + a.n, 0);
    for (const a of after) if (a.n) bad(`  ${a.arm}: ${a.n} still array-shaped`);
    note(`  array-shaped blocks remaining: ${left} (was ${total}); ${refuse.length} of those are the refused rows`);
    /* Prove the recovered rows read as objects again — an object that no
       consumer can query is the same as no object. */
    for (const r of fix.slice(0, 10)) {
      const [row] = await check.unsafe(
        `SELECT jsonb_typeof(variants) AS t, variants->>'fabricCode' AS fabric FROM ${r.t} WHERE id = $1`, [r.id]);
      note(`  ${r.arm} ${r.id}: variants is ${row?.t}, fabricCode reads "${row?.fabric ?? '(none)'}"`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
