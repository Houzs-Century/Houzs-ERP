/* Every read in computeMrp is paged — enforced on the source, not asserted in
 * prose.
 *
 * The PR that introduced this said "every read in computeMrp is paged". A claim
 * like that is true on the day it is written and quietly false a month later,
 * when someone adds `await sb.from('x').select(...)` to the function because
 * every line around it looks like a normal query. The failure is silent by
 * construction: PostgREST returns one page and no error, so the new read works
 * perfectly against any dataset small enough to test by hand.
 *
 * So: find computeMrp's body, find every `sb.from(` in it, and require each one
 * to be inside a paginateAll/chunkIn factory — recognised by the `.range(from,
 * to)` the factory must wire through.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/scm/routes/mrp.ts');

/** computeMrp's body: from its signature to the first column-0 `}`. */
function computeMrpBody() {
  const lines = readFileSync(SRC, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('export async function computeMrp'));
  assert.notEqual(start, -1, 'computeMrp not found — did it move or get renamed?');
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, 'computeMrp has no closing brace at column 0');
  return { lines, start, end };
}

/* A read is paged when a `.range(from, to)` appears between its `sb.from(` and
   the end of the statement it belongs to. Statements here span several lines
   (select lists, embeds), so the window is "from this `sb.from(` to the next
   one, or the end of the body". */
function unpagedReads() {
  const { lines, start, end } = computeMrpBody();
  const body = lines.slice(start, end + 1);
  const at = [];
  body.forEach((l, i) => { if (l.includes('sb.from(')) at.push(i); });
  const bad = [];
  for (let n = 0; n < at.length; n++) {
    const from = at[n];
    const to = n + 1 < at.length ? at[n + 1] : body.length;
    const stmt = body.slice(from, to).join('\n');
    if (!stmt.includes('.range(from, to)')) {
      bad.push(`mrp.ts:${start + from + 1}  ${body[from].trim()}`);
    }
  }
  return bad;
}

test('every sb.from() read in computeMrp is inside a paged factory', () => {
  const bad = unpagedReads();
  assert.deepEqual(bad, [], [
    'These reads in computeMrp are not paged. PostgREST caps a response at',
    'db-max-rows and reports nothing, so an un-paged read is a silent slice of',
    'the plan, not a query. Wrap it in paginateAll (or chunkIn when it carries',
    'an .in() list) and wire .range(from, to) through the factory:',
    '',
    ...bad.map((b) => `  ${b}`),
  ].join('\n'));
});

test('the cap constant that could never be reached is gone and stays gone', () => {
  /* MRP_LOAD_CAP was 5000, compared against a read the edge capped far lower,
     so the guard read as protection and was dead code. Nothing may reintroduce
     a bound that is not the one paginateAll can actually reach. */
  const src = readFileSync(SRC, 'utf8');
  assert.equal(src.includes('MRP_LOAD_CAP'), false, 'MRP_LOAD_CAP is back in mrp.ts');
  assert.match(src, /PAGINATE_CEILING/, 'the truncation guard must compare against PAGINATE_CEILING');
});

test('computeMrp keeps no .limit() on a full-set read', () => {
  const { lines, start, end } = computeMrpBody();
  const offenders = lines.slice(start, end + 1)
    .map((l, i) => [start + i + 1, l])
    .filter(([, l]) => /\.limit\(/.test(l));
  assert.deepEqual(offenders.map(([n, l]) => `mrp.ts:${n} ${l.trim()}`), [],
    'a .limit() inside a paged factory makes the server return the smaller of the two and the walk stop early');
});
