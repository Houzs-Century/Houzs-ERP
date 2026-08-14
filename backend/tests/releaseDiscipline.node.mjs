// The release-discipline gate's own logic, tested against fixtures that are
// deliberately wrong. A gate nobody has watched fail is a gate nobody knows
// works — every rule below is exercised RED first, then GREEN with the one
// thing it was missing put back.
//
// Text in, findings out: no filesystem, no database. The runner
// (backend/scripts/check-release-discipline.mjs) does the I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripJsComments, headerComment, scanScript, scanMigration,
  indexLibExports, ratchetDiff, reconcileScriptLedger, floorShouldDropTo,
} from '../scripts/lib/release-discipline.mjs';

const NO_LIBS = new Map();

/** A repair script that gets everything right, used as the GREEN baseline. */
const COMPLIANT = `#!/usr/bin/env node
/* Repair the thing.

   RE-RUN: inert. Keyed on jsonb_typeof(variants) = 'array', which the write
   turns into 'object', so a second run selects nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error('MODE=apply requires CONFIRM');
  process.exit(2);
}
const sql = postgres(DSN, { max: 1 });
const rows = await sql\`SELECT id, variants FROM scm.mfg_sales_order_items WHERE jsonb_typeof(variants) = 'array'\`;
if (APPLY) {
  await sql\`UPDATE scm.mfg_sales_order_items SET variants = variants -> 0 WHERE id = ANY(\${rows.map((r) => r.id)})\`;
}
const verify = postgres(DSN, { max: 1 });
const left = await verify\`SELECT id, jsonb_typeof(variants) AS shape FROM scm.mfg_sales_order_items WHERE id = ANY(\${rows.map((r) => r.id)})\`;
if (left.some((r) => r.shape !== 'object')) process.exit(1);
await verify.end();
await sql.end();
`;

const scan = (source, name = 'fixture.mjs') => scanScript({ name, source, libExports: NO_LIBS });

test('the compliant baseline is a writer and fails nothing', () => {
  const r = scan(COMPLIANT);
  assert.equal(r.inScope, true);
  assert.equal(r.writes, true);
  assert.deepEqual(r.failed, []);
});

// ── scope ──────────────────────────────────────────────────────────────────

test('a script that opens no database is out of scope entirely', () => {
  const r = scan(`import { readFileSync } from 'node:fs';\nconst t = 'UPDATE scm.x SET y = 1';\nconsole.log(t);\n`);
  assert.equal(r.inScope, false);
  assert.equal(r.writes, false);
});

test('a read-only script that only PRINTS a write verb is not a writer', () => {
  // check-indexes.mjs prints "Dump CREATE INDEX statements: 41" and executes
  // two count(*)s. Flagging it would put a script nobody can ever fix on the
  // grandfather list.
  const r = scan(`import postgres from 'postgres';
const pg = postgres(process.env.DATABASE_URL);
const n = (dump.match(/CREATE INDEX/gi) || []).length;
console.log(\`Dump CREATE INDEX statements: \${n}\`);
`);
  assert.equal(r.inScope, true);
  assert.equal(r.writes, false);
});

test('a header that describes the damage it repairs is not a write', () => {
  const r = scan(`import postgres from 'postgres';
// The old pass ran DELETE FROM scm.fabric_colours and lost the labels.
const pg = postgres(process.env.DATABASE_URL);
await pg\`SELECT count(*) FROM scm.fabric_colours\`;
`);
  assert.equal(r.writes, false);
});

test('an INTERPOLATED table name is still an UPDATE', () => {
  // `UPDATE ${arm.t} SET` is how every multi-arm repair in this tree writes,
  // including the two the gate exists for.
  const r = scan(`import postgres from 'postgres';
const pg = postgres(process.env.DATABASE_URL);
await pg.unsafe(\`UPDATE \${arm.t} SET variants = $1 WHERE id = $2\`, [a, b]);
`);
  assert.equal(r.writes, true);
  assert.deepEqual(r.evidence, ['UPDATE … SET']);
});

test('a PostgREST chain through the shim counts as a write', () => {
  const r = scan(`import { pgrestShim } from './lib/pgrest-shim.mjs';
const sb = pgrestShim(sql);
await sb.from('autocount_outbox').eq('status', 'skipped').update({ status: 'pending' });
`);
  assert.equal(r.writes, true);
});

test('map.delete and hash.update are not database writes', () => {
  const r = scan(`import postgres from 'postgres';
const pg = postgres(process.env.DATABASE_URL);
taken.delete(p.po_number);
const md5 = crypto.createHash('md5').update(String(x)).digest('hex');
await pg\`SELECT 1\`;
`);
  assert.equal(r.writes, false);
});

test('a write reached only through a lib helper is still a write', () => {
  const libExports = indexLibExports([['fabric-write.mjs', `
export async function countColour(db, code) {
  return db\`SELECT count(*) FROM scm.fabric_colours WHERE code = \${code}\`;
}
export async function repointColour(db, from, to) {
  return db\`UPDATE scm.fabric_colours SET code = \${to} WHERE code = \${from}\`;
}
`]]);
  const importer = (names) => scanScript({
    name: 'x.mjs',
    source: `import postgres from 'postgres';\nimport { ${names} } from './lib/fabric-write.mjs';\nconst pg = postgres(process.env.DATABASE_URL);\n`,
    libExports,
  });
  assert.equal(importer('repointColour').writes, true, 'the writing export makes its importer a writer');
  assert.equal(importer('countColour').writes, false, 'importing only the reader does not');
});

// ── rule: mode-gate ────────────────────────────────────────────────────────

test('RED: no MODE/APPLY gate at all', () => {
  const r = scan(COMPLIANT.replace("const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';", 'const APPLY = true;'));
  assert.ok(r.failed.includes('mode-gate'));
  assert.match(r.detail['mode-gate'], /writes on a bare run/);
});

test('RED: an opt-OUT switch is named as one — unset, it writes', () => {
  const r = scan(COMPLIANT.replace("const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';", "const APPLY = process.env.DRY_RUN !== '1';"));
  assert.ok(r.failed.includes('mode-gate'));
  assert.match(r.detail['mode-gate'], /opt-OUT/);
});

test('RED: MODE defaulting to apply is not a gate', () => {
  const r = scan(COMPLIANT.replace("process.env.MODE || 'plan'", "process.env.MODE || 'apply'"));
  assert.ok(r.failed.includes('mode-gate'));
});

test('GREEN: any non-apply MODE default passes, not just the word "plan"', () => {
  // unify-processing-date.mjs spells it 'dry-run' and is the model BUG-HISTORY
  // tells people to copy.
  const r = scan(COMPLIANT.replace("process.env.MODE || 'plan'", "process.env.MODE || 'dry-run'"));
  assert.ok(!r.failed.includes('mode-gate'));
});

test('GREEN: APPLY=1 is a gate — unset is false', () => {
  const r = scan(COMPLIANT.replace("const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';", "const APPLY = process.env.APPLY === '1';"));
  assert.ok(!r.failed.includes('mode-gate'));
});

// ── rule: confirm-phrase ───────────────────────────────────────────────────

test('RED: no CONFIRM on the apply path', () => {
  const r = scan(COMPLIANT.replace(/if \(APPLY && process\.env\.CONFIRM[\s\S]*?\n}\n/, ''));
  assert.ok(r.failed.includes('confirm-phrase'));
});

test('RED: CONFIRM is read but nothing refuses when it does not match', () => {
  const r = scan(COMPLIANT.replace("  console.error('MODE=apply requires CONFIRM');\n  process.exit(2);", "  console.warn('no confirm');"));
  assert.ok(r.failed.includes('confirm-phrase'));
  assert.match(r.detail['confirm-phrase'], /nothing exits or throws/);
});

test('RED: CONFIRM=1 is not a phrase', () => {
  const r = scan(COMPLIANT.replace("const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';", "const CONFIRM_PHRASE = '1';"));
  assert.ok(r.failed.includes('confirm-phrase'));
  assert.match(r.detail['confirm-phrase'], /shorter than 8/);
});

// ── rule: fresh-verify ─────────────────────────────────────────────────────

test('RED: the writing session is the only witness', () => {
  const r = scan(COMPLIANT.replace('const verify = postgres(DSN, { max: 1 });', 'const verify = sql;'));
  assert.ok(r.failed.includes('fresh-verify'));
  assert.match(r.detail['fresh-verify'], /worst witness/);
});

test('RED: a fresh connection that reads nothing back', () => {
  const r = scan(COMPLIANT.replace(/const left = await verify[\s\S]*?process\.exit\(1\);\n/, ''));
  assert.ok(r.failed.includes('fresh-verify'));
  assert.match(r.detail['fresh-verify'], /nothing is read back/);
});

test('RED: the row count says 7 of 7 — this is the 2026-08-13 incident', () => {
  const countOnly = COMPLIANT.replace(
    "const left = await verify`SELECT id, jsonb_typeof(variants) AS shape FROM scm.mfg_sales_order_items WHERE id = ANY(${rows.map((r) => r.id)})`;\nif (left.some((r) => r.shape !== 'object')) process.exit(1);",
    "const [{ n }] = await verify`SELECT count(*)::int AS n FROM scm.mfg_sales_order_items WHERE id = ANY(${rows.map((r) => r.id)})`;\nif (n !== rows.length) process.exit(1);",
  );
  const r = scan(countOnly);
  assert.ok(r.failed.includes('fresh-verify'), 'a count-only read-back must not pass');
  assert.match(r.detail['fresh-verify'], /only for a COUNT/);
});

test('GREEN: a count query whose PREDICATE is the shape check passes', () => {
  // repair-array-shaped-variants.mjs verifies with
  // `SELECT COUNT(*) ... WHERE jsonb_typeof(i.variants) IN ('array','string')`.
  // That is a count, and it is the strongest verification in the tree.
  const r = scan(COMPLIANT.replace(
    "const left = await verify`SELECT id, jsonb_typeof(variants) AS shape FROM scm.mfg_sales_order_items WHERE id = ANY(${rows.map((r) => r.id)})`;\nif (left.some((r) => r.shape !== 'object')) process.exit(1);",
    "const [{ n }] = await verify`SELECT count(*)::int AS n FROM scm.mfg_sales_order_items WHERE jsonb_typeof(variants) <> 'object'`;\nif (n) process.exit(1);",
  ));
  assert.ok(!r.failed.includes('fresh-verify'));
});

test('GREEN: the shape check may live in a helper declared above the write', () => {
  // Both scripts the gate was written for call `damaged(v, t)` / `census(v, t)`,
  // declared at the top of the file. Reading only the text after the fresh
  // connection would judge them as asserting nothing.
  const viaHelper = COMPLIANT.replace(
    "const left = await verify`SELECT id, jsonb_typeof(variants) AS shape FROM scm.mfg_sales_order_items WHERE id = ANY(${rows.map((r) => r.id)})`;\nif (left.some((r) => r.shape !== 'object')) process.exit(1);",
    'const left = await damaged(verify);\nif (left.length) process.exit(1);',
  ).replace(
    "import postgres from 'postgres';",
    "import postgres from 'postgres';\nconst damaged = (db) => db`SELECT id FROM scm.mfg_sales_order_items WHERE jsonb_typeof(variants) = 'array'`;",
  );
  const r = scan(viaHelper);
  assert.ok(!r.failed.includes('fresh-verify'));
});

// ── rule: rerun-note ───────────────────────────────────────────────────────

test('RED: no re-run note in the header', () => {
  const r = scan(COMPLIANT.replace(/\n   RE-RUN:[\s\S]*?selects nothing\./, ''));
  assert.ok(r.failed.includes('rerun-note'));
  assert.match(r.detail['rerun-note'], /SECOND run/);
});

test('RED: an empty RE-RUN marker', () => {
  const r = scan(COMPLIANT.replace(/RE-RUN:[\s\S]*?selects nothing\./, 'RE-RUN: yes'));
  assert.ok(r.failed.includes('rerun-note'));
  assert.match(r.detail['rerun-note'], /nothing follows it/);
});

test('a RE-RUN note in the BODY does not count — it has to be in the header', () => {
  const body = COMPLIANT.replace(/\n   RE-RUN:[\s\S]*?selects nothing\./, '')
    + "\n// RE-RUN: inert, keyed on a shape the write destroys, so a second pass selects nothing.\n";
  assert.ok(scan(body).failed.includes('rerun-note'));
});

// ── migrations ─────────────────────────────────────────────────────────────

test('RED: a migration with no reversal note', () => {
  const r = scanMigration({ name: '0287_add_column.sql', source: '-- 0287 — add a column.\nALTER TABLE scm.x ADD COLUMN y text;\n' });
  assert.deepEqual(r.failed, ['reversal-note']);
  assert.equal(r.number, 287);
});

test('RED: a reversal note that says nothing', () => {
  const r = scanMigration({ name: '0287_add_column.sql', source: '-- REVERSAL: n/a\nALTER TABLE scm.x ADD COLUMN y text;\n' });
  assert.deepEqual(r.failed, ['reversal-note']);
});

test('GREEN: a real reversal note', () => {
  const r = scanMigration({ name: '0287_add_column.sql', source: '-- REVERSAL: ALTER TABLE scm.x DROP COLUMN y; no data outside the column.\nALTER TABLE scm.x ADD COLUMN y text;\n' });
  assert.deepEqual(r.failed, []);
});

test('GREEN: IRREVERSIBLE is an answer, as long as it says why', () => {
  const r = scanMigration({ name: '0288_drop.sql', source: '-- REVERSAL: IRREVERSIBLE — the column is dropped and its values are not copied anywhere first.\nALTER TABLE scm.x DROP COLUMN y;\n' });
  assert.deepEqual(r.failed, []);
});

test('RED: the 0189 view trap — a DROP VIEW whose reversal note forgets the grants', () => {
  // 0189 did DROP VIEW -> DROP COLUMN -> CREATE VIEW, which is correct SQL and
  // discarded the view's whole ACL. Prod's Sales Order list then failed for
  // every user, and it took 0190 and 0191 to put back grants nobody had
  // written down.
  const r = scanMigration({
    name: '0287_retire_column.sql',
    source: `-- REVERSAL: recreate the view with processing_date and re-add the column.
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;
ALTER TABLE scm.mfg_sales_orders DROP COLUMN processing_date;
CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS SELECT 1;
`,
  });
  assert.deepEqual(r.failed, ['reversal-note-grants']);
});

test('GREEN: the same migration once the note names the grants', () => {
  const r = scanMigration({
    name: '0287_retire_column.sql',
    source: `-- REVERSAL: recreate the view with processing_date, then re-apply the GRANTs
--   from 0084 and the owner — a recreated view is a new object with an empty ACL.
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;
CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS SELECT 1;
`,
  });
  assert.deepEqual(r.failed, []);
});

// The rule reads what a migration DOES, so it reads SQL, not prose. A file that
// uses CREATE OR REPLACE precisely so that no ACL is lost, and says so, was
// failed for naming the hazard it had avoided — under a message telling it to
// go and do that hazard. This is the real mig 0290, reduced.
test('GREEN: DROP VIEW named only in a comment is not a drop', () => {
  const r = scanMigration({
    name: '0290_gl_view.sql',
    source: `-- REVERSAL: re-run mig 0106's CREATE OR REPLACE block, this view's full prior text.
--   A view holds no data, so nothing is lost either way.
--
-- The tempting repair is DROP VIEW + CREATE VIEW, and it is the wrong one: a
-- recreated view is a NEW object with an EMPTY ACL, which is how 0189 took the
-- Sales Order list down for every user. Matching the live column list keeps
-- this a REPLACE, so no privilege is ever dropped.
CREATE OR REPLACE VIEW scm.v_gl_entries AS SELECT 1;
`,
  });
  assert.deepEqual(r.failed, []);
});

// ...and the guard is still armed. Same file, same prose, one real statement
// added. If this ever goes green, blanking comments has gone too far.
test('RED: a real DROP VIEW still fails even when a comment discusses one', () => {
  const r = scanMigration({
    name: '0290_gl_view.sql',
    source: `-- REVERSAL: re-run mig 0106's block. A view holds no data.
--
-- The tempting repair is DROP VIEW + CREATE VIEW, and it is the wrong one.
DROP VIEW IF EXISTS scm.v_gl_entries;
CREATE VIEW scm.v_gl_entries AS SELECT 1;
`,
  });
  assert.deepEqual(r.failed, ['reversal-note-grants']);
});

// A block comment hides it just as well as a line comment, and the two are
// stripped by different branches.
test('GREEN: DROP VIEW inside a /* block */ comment is not a drop either', () => {
  const r = scanMigration({
    name: '0290_gl_view.sql',
    source: `-- REVERSAL: re-run mig 0106's block. A view holds no data.
/* Considered and rejected: DROP VIEW scm.v_gl_entries; CREATE VIEW ... —
   it would discard the ACL. */
CREATE OR REPLACE VIEW scm.v_gl_entries AS SELECT 1;
`,
  });
  assert.deepEqual(r.failed, []);
});

// ── the ratchet ────────────────────────────────────────────────────────────

test('a shrinking list is the only allowed direction', () => {
  const base = { scripts: { 'a.mjs': ['mode-gate', 'rerun-note'], 'b.mjs': ['confirm-phrase'] }, migrationReversalNoteRequiredFrom: 287 };
  assert.deepEqual(ratchetDiff(base, { scripts: { 'a.mjs': ['mode-gate'] }, migrationReversalNoteRequiredFrom: 287 }), []);
  assert.deepEqual(ratchetDiff(base, { scripts: { ...base.scripts }, migrationReversalNoteRequiredFrom: 286 }), []);
});

test('RED: a new grandfather entry is growth', () => {
  const base = { scripts: { 'a.mjs': ['mode-gate'] }, migrationReversalNoteRequiredFrom: 287 };
  const grew = ratchetDiff(base, { scripts: { 'a.mjs': ['mode-gate'], 'new.mjs': ['confirm-phrase'] }, migrationReversalNoteRequiredFrom: 287 });
  assert.equal(grew.length, 1);
  assert.match(grew[0], /new\.mjs.*NEW grandfather entry/);
});

test('RED: a new rule on an existing entry is growth', () => {
  const base = { scripts: { 'a.mjs': ['mode-gate'] }, migrationReversalNoteRequiredFrom: 287 };
  const grew = ratchetDiff(base, { scripts: { 'a.mjs': ['mode-gate', 'fresh-verify'] }, migrationReversalNoteRequiredFrom: 287 });
  assert.equal(grew.length, 1);
  assert.match(grew[0], /newly exempted from fresh-verify/);
});

test('RED: raising the migration floor exempts migrations that already had to comply', () => {
  const base = { scripts: {}, migrationReversalNoteRequiredFrom: 287 };
  const grew = ratchetDiff(base, { scripts: {}, migrationReversalNoteRequiredFrom: 292 });
  assert.equal(grew.length, 1);
  assert.match(grew[0], /moved UP 287 -> 292, exempting 5/);
});

// ── the ledger reconciliation: the half that makes the list SHRINK ────────

const scanned = [
  { name: 'a.mjs', writes: true, failed: ['mode-gate', 'rerun-note'] },
  { name: 'b.mjs', writes: true, failed: [] },
  { name: 'c.mjs', writes: false, failed: [] },
];

test('an entry that still describes reality is left alone', () => {
  assert.deepEqual(reconcileScriptLedger(scanned, { 'a.mjs': ['mode-gate', 'rerun-note'] }), []);
});

test('RED: a rule the script now PASSES has to come off the entry', () => {
  const [p] = reconcileScriptLedger(scanned, { 'a.mjs': ['mode-gate', 'rerun-note', 'fresh-verify'] });
  assert.equal(p.kind, 'fixed');
  assert.deepEqual(p.rules, ['fresh-verify']);
});

test('RED: an entry for a script that passes everything is dead weight', () => {
  assert.equal(reconcileScriptLedger(scanned, { 'b.mjs': ['mode-gate'] })[0].kind, 'fixed');
});

test('RED: an entry for a deleted script, a non-writer, and an empty exemption', () => {
  assert.equal(reconcileScriptLedger(scanned, { 'ghost.mjs': ['mode-gate'] })[0].kind, 'gone');
  assert.equal(reconcileScriptLedger(scanned, { 'c.mjs': ['mode-gate'] })[0].kind, 'not-writer');
  assert.equal(reconcileScriptLedger(scanned, { 'a.mjs': [] })[0].kind, 'empty');
});

test('RED: a typo in a rule id is reported as a typo, not as "now satisfied"', () => {
  const out = reconcileScriptLedger(scanned, { 'a.mjs': ['mode-gate', 'rerun-note', 'moad-gate'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'unknown');
  assert.deepEqual(out[0].rules, ['moad-gate']);
});

test('the migration floor comes down with the contiguous compliant tail', () => {
  const m = (number, failed) => ({ name: `${number}.sql`, number, failed });
  // 283 non-compliant, 284..286 compliant, floor 287 -> must drop to 284.
  assert.equal(floorShouldDropTo([m(283, ['reversal-note']), m(284, []), m(285, []), m(286, [])], 287), 284);
  // The file directly below the floor does not comply: nothing moves.
  assert.equal(floorShouldDropTo([m(284, []), m(285, []), m(286, ['reversal-note'])], 287), null);
  // A lone compliant file deep in the tree is not a reason to move the boundary.
  assert.equal(floorShouldDropTo([m(100, []), m(286, ['reversal-note'])], 287), null);
});

// ── the text tools underneath ──────────────────────────────────────────────

test('stripJsComments keeps strings and drops comments and regex bodies', () => {
  const out = stripJsComments(`const a = "DELETE FROM t"; // DROP TABLE t\n/* INSERT INTO t */ const re = /TRUNCATE t/g;\n`);
  assert.match(out, /DELETE FROM t/);
  assert.doesNotMatch(out, /DROP TABLE/);
  assert.doesNotMatch(out, /INSERT INTO/);
  assert.doesNotMatch(out, /TRUNCATE/);
});

test('stripJsComments does not mistake division for a regex', () => {
  const out = stripJsComments('const pct = done / total; const half = n / 2;\nconst s = "keep me";\n');
  assert.match(out, /keep me/);
  assert.match(out, /done \/ total/);
});

test('headerComment stops at the first line of code', () => {
  const h = headerComment('#!/usr/bin/env node\n// one\n// two\nimport x from "y";\n// three\n');
  assert.match(h, /one/);
  assert.match(h, /two/);
  assert.doesNotMatch(h, /three/);
});
