// ---------------------------------------------------------------------------
// jsonbBindScan.node.mjs — the checker's own proof.
//
// A guard that has never been shown to fail is not known to work. Six of the
// ~833 BUG-HISTORY entries were mechanisms that shipped complete and had never
// once fired; two of them were guards. So the scanner behind
// `npm run audit:jsonb-binds` is exercised here against the REAL source of every
// occurrence of the class, in both the shape that caused it and the shape that
// fixed it — the fixtures below are transcribed from the actual files.
//
// node:test and not vitest, for the same reason the checker is a script: the
// backend suite runs in workerd and cannot read the filesystem.
//
//   node --test backend/tests/jsonbBindScan.node.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSource,
  blankComments,
  placeholderIsTextFunnelled,
  stripSqlComments,
} from '../scripts/lib/jsonb-bind-scan.mjs';

const scan = (src) => scanSource('fixture.mjs', src);

// -- the shapes that caused real production damage --------------------------

test('flags a stringified value interpolated into a tagged template (2026-08-13, backfill-2990-delivered-dos.mjs)', () => {
  const found = scan(`
    await pg\`
      INSERT INTO scm.mfg_so_audit_log (so_doc_no, field_changes)
      VALUES (\${docNo}, \${JSON.stringify([{ field: "status", to: "DELIVERED" }])})\`;
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'template');
});

test('flags a stringified param bound to $n::jsonb via .unsafe (2026-08-10, split-collapsed-sofa-lines.mjs)', () => {
  const found = scan(`
    const ins = await tx.unsafe(
      \`INSERT INTO scm.mfg_sales_order_items (variants)
        SELECT COALESCE(i.variants,'{}'::jsonb) || $2::jsonb FROM x i WHERE i.id = $3\`,
      [code, JSON.stringify({ seatHeight: p.seat }), p.row.id]);
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unsafe');
  assert.match(found[0].snippet, /^\$2 <-/);
});

test('flags the original 2026-08-10 refresh-sofa-colours shape ($1::jsonb, single param)', () => {
  const found = scan(`
    await sql.unsafe('UPDATE scm.x SET variants = $1::jsonb WHERE id = $2', [JSON.stringify(u.patch), id]);
  `);
  assert.equal(found.length, 1);
  assert.match(found[0].snippet, /^\$1 <-/);
});

// -- the shapes that are correct, and must stay silent ----------------------

test('does NOT flag sql.json() / tx.json(), the preferred fix', () => {
  assert.deepEqual(scan("await tx`UPDATE scm.x SET variants = variants || ${tx.json({ seatHeight: 28 })}`;"), []);
  assert.deepEqual(scan("await sql`UPDATE scm.x SET v = ${sql.json(obj)}`;"), []);
});

test('does NOT flag the ::text::jsonb funnel, the allowed .unsafe escape (repair-array-shaped-variants.mjs)', () => {
  const found = scan(`
    const back = await sql.unsafe(
      \`UPDATE \${r.t} SET variants = $2::text::jsonb WHERE id = $1 RETURNING id::text AS id\`,
      [r.id, JSON.stringify(r.obj)]);
  `);
  assert.deepEqual(found, []);
});

test('the ::text funnel is matched per placeholder, not per statement', () => {
  // $1 is funnelled, $2 is not. Only $2 may be reported.
  const found = scan(`
    await sql.unsafe('UPDATE t SET a = $1::text::jsonb, b = $2::jsonb', [JSON.stringify(a), JSON.stringify(b)]);
  `);
  assert.equal(found.length, 1);
  assert.match(found[0].snippet, /^\$2 <-/);
  assert.ok(placeholderIsTextFunnelled('SET a = $1::text::jsonb', 1));
  assert.ok(!placeholderIsTextFunnelled('SET b = $2::jsonb', 2));
});

test('does NOT flag JSON.stringify outside a query — logging, comparison, notes', () => {
  assert.deepEqual(scan(`
    if (JSON.stringify(mine) !== JSON.stringify(v)) note(\`then: \${JSON.stringify(r.obj)}\`);
    console.log(JSON.stringify(payload));
  `), []);
});

// -- the false positive that would have made the checker unusable -----------

test('does NOT flag a prose WARNING about the trap (pg-supabase-transaction.ts)', () => {
  // Transcribed from the real file: correct code, with a comment that describes
  // the wrong code. The first run of this checker flagged it, which is how a
  // guard trains people to ignore it.
  const found = scan(`
    await sql.unsafe(
      'SELECT scm.rebuild_mfg_so_delivery_lines($1::text, $4::jsonb)',
      [
        args.p_doc_no,
        // sql.json(), NOT JSON.stringify(): binding a pre-stringified string
        // to a $n::jsonb parameter double-serializes it.
        sql.json(args.p_rows ?? []),
      ]);
  `);
  assert.deepEqual(found, []);
});

test('a SQL COMMENT mentioning ::text cannot satisfy the funnel check', () => {
  // Found by mutation-testing this checker. split-collapsed-sofa-lines.mjs was
  // fixed to `$2::text::jsonb` and given a comment saying so; reverting only
  // the CODE left the comment, and the funnel test matched the comment and
  // passed the file. The guard stopped guarding the site it was written for.
  const found = scan(`
    await tx.unsafe(
      \`INSERT INTO scm.x (variants)
        -- $2::TEXT::jsonb, and the ::text is load-bearing.
        SELECT COALESCE(i.variants,'{}'::jsonb) || $2::jsonb FROM y i\`,
      [code, JSON.stringify({ seatHeight: 28 }), id]);
  `);
  assert.equal(found.length, 1, 'the comment must not launder the missing ::text cast');
  assert.match(found[0].snippet, /^\$2 <-/);
  assert.equal(stripSqlComments('a -- $2::text::jsonb\nb'), 'a  \nb');
  assert.ok(!placeholderIsTextFunnelled('-- $2::text::jsonb\nSET v = $2::jsonb', 2));
});

test('blankComments preserves byte offsets and line numbers', () => {
  const src = 'a\n// JSON.stringify(x)\nb';
  const out = blankComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes('JSON.stringify'));
});

test('blankComments does not blank a // inside a string or template', () => {
  const src = 'const u = "http://x"; sql`SELECT 1 -- not a js comment`;';
  assert.equal(blankComments(src), src);
});

// -- the scanner must survive the syntax the repo actually writes ------------

test('nested template interpolation does not desynchronise the scan', () => {
  const found = scan(`
    await sql\`INSERT INTO t (\${cols.map((c) => \`"\${c}"\`).join(',')}) VALUES (\${JSON.stringify(v)})\`;
  `);
  assert.equal(found.length, 1, 'the stringify after a nested template must still be seen');
});

test('a params array containing objects and arrays is indexed correctly', () => {
  const found = scan(`
    await sql.unsafe('UPDATE t SET a=$1, b=$2, c=$3::jsonb', [{ x: 1 }, [1, 2], JSON.stringify(c)]);
  `);
  assert.equal(found.length, 1);
  assert.match(found[0].snippet, /^\$3 <-/);
});
