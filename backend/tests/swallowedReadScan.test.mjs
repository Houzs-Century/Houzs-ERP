// ---------------------------------------------------------------------------
// swallowedReadScan.node.mjs — the ratchet's own proof.
//
// The census this gate replaces was a single-line grep, and it was wrong in
// both directions: BUG-HISTORY 2026-07-17, "The zeroing roll-up is in FIFTEEN
// money documents, not six — and the entry below pointed 'SI' at a mirror while
// the GL-writing original went unlisted. ... The flagged list was wrong in both
// directions." So the scanner that replaces it is tested on the shapes that
// grep got wrong: multi-line destructures, aliases, and comments.
//
//   node --test backend/tests/swallowedReadScan.node.mjs
// ---------------------------------------------------------------------------

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { scanErrorlessReads, scanBareCatches } from '../scripts/lib/swallowed-read-scan.mjs';

const reads = (s) => scanErrorlessReads(s).length;
const catches = (s) => scanBareCatches(s).length;

// -- the shape that moved money ---------------------------------------------

test('counts a read that discards its error', () => {
  assert.equal(reads('const { data } = await sb.from("payments").select("*");'), 1);
  assert.equal(reads('const { data: rows } = await sb.from("x").select("*");'), 1);
  assert.equal(reads('const { data, count } = await sb.from("x").select("*");'), 1);
});

test('does NOT count a read that binds its error', () => {
  assert.equal(reads('const { data, error } = await sb.from("x").select("*");'), 0);
  assert.equal(reads('const { data: rows, error: err } = await sb.from("x").select("*");'), 0);
});

test('a MULTI-LINE destructure counts the same as a one-liner', () => {
  // The 2026-07-17 census grepped single lines, so every wrapped destructure
  // was invisible to the number the sweep was steering by — on both sides.
  assert.equal(
    reads(`const {
        data,
        count,
      } = await sb.from("x").select("*", { count: "exact" });`),
    1,
  );
  assert.equal(
    reads(`const {
        data,
        error,
      } = await sb.from("x").select("*");`),
    0,
  );
});

test('does NOT count a destructure that is not an awaited read', () => {
  assert.equal(reads('const { data } = props;'), 0);
  assert.equal(reads('const { data } = useQuery();'), 0);
  assert.equal(reads('const { data } = res.body;'), 0);
});

test('does NOT count a comment describing the shape', () => {
  // The repo is full of prose warnings about this exact pattern. A warning
  // must never read as an instance.
  assert.equal(reads('// never write const { data } = await sb.from("x")\nconst { data, error } = await q();'), 0);
  assert.equal(reads('/* const { data } = await bad(); */'), 0);
});

// -- the third recorded variant: the bare catch ------------------------------

test('counts bare catches and their silent siblings', () => {
  assert.equal(catches('void load().catch(() => {});'), 1);
  assert.equal(catches('const x = await load().catch(() => undefined);'), 1);
  assert.equal(catches('const x = await load().catch(() => null);'), 1);
  assert.equal(catches('const x = await load().catch(() => []);'), 1);
  assert.equal(catches('void load().catch(async () => {});'), 1);
});

test('does NOT count a catch that binds and uses the rejection', () => {
  assert.equal(catches('load().catch((e) => report(e));'), 0);
  assert.equal(catches('load().catch(() => setError("reference read failed"));'), 0);
});

test('line numbers survive comment blanking', () => {
  const hits = scanErrorlessReads('// pad\n/* pad\n   pad */\nconst { data } = await q();');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
});
