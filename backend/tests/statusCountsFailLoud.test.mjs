// THIS FILE MUST STAY IN THE `light` PROJECT — same reasons as
// statusBucketsEnumMembership.test.mjs: it reads the tree with node:fs (which
// does not exist in workerd), and it has to gate a MERGE, and only the light
// project runs inside a required context. It is pinned in classifyTests.test.mjs's
// MUST_GATE_MERGE. Keep `cloudflare:test` and `env.DB` out of this file's CODE.
//
// EVERY PAGINATED SCM LIST THAT SERVES `statusCounts` MUST FAIL LOUD WHEN A
// COUNT CANNOT BE READ.
//
// WHY THIS EXISTS, and why it is a POPULATION test rather than a list of files.
// On 2026-08-17 five list endpoints were repaired: a count query that FAILED
// also has a null count, so `count ?? 0` served a broken bucket as an empty one
// — a zero on the tab, no error, nothing in the log. The repair (lib/status-counts.ts)
// landed at the five sites someone had named.
//
// It missed a SIXTH. `mfg-sales-orders.ts` — the largest SO list in the system —
// serves the same `statusCounts` contract from a grouped aggregate with a
// paginate-all fallback, and the fallback's `error` was never inspected:
// paginateAll answers a failure with `{ data: null, error }`, so
// `for (const r of (fb.data ?? []))` tallied a failure as ZERO ROWS. Both reads
// failing produced `{ all: 0, draft: 0, ... other: 0 }` beside a fully populated
// page of orders. It was invisible to the bucket-membership gate, which keys off
// the `*_STATUS_BUCKETS` naming convention that this endpoint does not use.
//
// So the population here is discovered from the RESPONSE CONTRACT, not from a
// hand-written list: any handler that returns `pageSize, statusCounts` is a
// paginated SCM list serving filter-pill counts. There is deliberately no
// exemption list — a suppression the reader cannot see is a suppression nobody
// re-checks.
//
// CORRECTED 2026-08-18, and this correction is the same defect as the one this
// branch had already fixed once, in statusBucketsEnumMembership.test.mjs. The
// first version of THIS file said "the seventh one will be caught the day it is
// written" while keying its population by FILE: one entry per file, with
// `failsLoud: src.includes('status_counts_failed')` — a whole-file substring
// test. Both halves were demonstrated, not theorised:
//   (a) a second, completely unguarded paginated statusCounts handler appended
//       to grns.ts — a file that already contains the marker elsewhere — left
//       this suite at "8 passed". A seventh list is caught only if it lands in
//       a BRAND-NEW file, and a second list inside an existing 12,000-line
//       router is the likelier shape, not the exotic one.
//   (b) deleting the real guard out of mfg-sales-orders.ts and leaving
//       `// TODO: one day return status_counts_failed here` in its place also
//       left the suite green: the scan could not tell a guard from a comment.
// The population is now one entry per HANDLER BLOCK, the source has its
// comments stripped before anything is matched, and scanStatusCountLists() is
// a pure function with its own self-tests below covering both shapes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(backendRoot, "src");

/* The paginated SCM list contract: `{ <docs>, total, page, pageSize, statusCounts }`.
   Matching on the pageSize+statusCounts pair rather than on `statusCounts`
   alone keeps out surfaces that legitimately shape counts a different way —
   fleet-maintenance's dashboard tallies rows it has ALREADY read, behind a
   `firstErr` check that 500s before any tallying, so it cannot serve a count it
   could not read. */
const LIST_CONTRACT = /pageSize,\s*statusCounts/;

/* What "loud" means, and it is the same string in every one of them: the 500
   body's error code. Fail on its absence rather than on any particular helper,
   so a list that computes counts its own way still has to answer the question. */
const FAILS_LOUD = "status_counts_failed";

/* A floor, not a target. Six such lists existed on 2026-08-18 (PO, PI, SI, GRN,
   DO, SO). If the scan ever finds fewer, the pattern is dead and a verdict
   computed over nothing must never read as a pass. */
const MIN_EXPECTED_LISTS = 6;

/* A route registration at module scope: `grns.get('/', async (c) => {`. Column
   0 on purpose — every one of the six routers registers this way, and anchoring
   there keeps a `.get(` inside a chained PostgREST expression from being read as
   the start of a new handler. */
const HANDLER_START = /^([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\3/;

/* Any OTHER top-level declaration also ends the block. Without this a helper
   function declared between two handlers is read as part of the handler above
   it, and a marker inside that helper would answer for a list inside the
   helper — the file-level hole again, one scope smaller. Route bodies are
   indented, so column 0 is what makes this top-level. */
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/;

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Comments replaced by spaces, newlines kept so every line number survives.
 *  A guard is CODE; `// TODO: return status_counts_failed here` is not one, and
 *  before this the scan could not tell them apart. String and template literals
 *  are walked so a `//` inside a URL is not read as a comment. A regex literal
 *  holding an unmatched quote would confuse the walk — if it ever does, it can
 *  only swallow code and make a real guard invisible, which this suite reports
 *  as a FAILURE, never as a pass. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      out += c; i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === "\\") { i += 1; if (i < src.length) out += src[i]; i += 1; continue; }
        if (src[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every paginated statusCounts list in one source text, ONE ENTRY PER HANDLER.
 *  Pure, so the two-lists-in-one-file case and the guard-is-only-a-comment case
 *  have self-tests below rather than a one-off manual demo.
 *
 *  Keyed by the handler block the response is returned FROM, never by the file:
 *  `src.includes(FAILS_LOUD)` over a whole 12,000-line router answers "does some
 *  handler in this file guard its counts", which is not the question. */
function scanStatusCountLists(src) {
  const lines = stripComments(src).split("\n");
  /* Segment at route registrations AND at every other top-level declaration.
     Everything before the first is module scope, which still gets checked — a
     contract served from a helper is a list too. */
  const blocks = [{ label: "(module scope)", start: 1, lines: [] }];
  lines.forEach((line, idx) => {
    const handler = HANDLER_START.exec(line);
    const decl = handler ? null : TOP_LEVEL_DECL.exec(line);
    if (handler) blocks.push({ label: `${handler[1]}.${handler[2]}('${handler[4]}')`, start: idx + 1, lines: [] });
    else if (decl) blocks.push({ label: `${decl[1]}()`, start: idx + 1, lines: [] });
    blocks[blocks.length - 1].lines.push(line);
  });

  const out = [];
  for (const block of blocks) {
    const body = block.lines.join("\n");
    /* Matched over the BODY, not line by line: the contract is frequently
       written across several lines and `\s*` has to be allowed to cross one. */
    const hit = LIST_CONTRACT.exec(body);
    if (!hit) continue;
    const line = block.start + body.slice(0, hit.index).split("\n").length - 1;
    out.push({ handler: block.label, line, failsLoud: body.includes(FAILS_LOUD) });
  }
  return out;
}

function findStatusCountLists() {
  const found = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("statusCounts")) continue;
    const rel = path.relative(backendRoot, file).split(path.sep).join("/");
    for (const list of scanStatusCountLists(src)) {
      found.push({ rel, key: `${rel} ${list.handler}`, ...list });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

const lists = findStatusCountLists();

describe("the checker itself", () => {
  test("the scan finds the paginated SCM lists, so the verdict is over something", () => {
    assert.ok(
      lists.length >= MIN_EXPECTED_LISTS,
      `found ${lists.length} paginated statusCounts lists, expected at least ${MIN_EXPECTED_LISTS}: `
      + `${lists.map((l) => l.key).join(", ") || "(none)"}. The pattern is dead, not the codebase — `
      + `a verdict computed over nothing must never read as a pass.`,
    );
  });

  test("the LOUD marker is a real string in the tree, not a spelling nobody uses", () => {
    assert.ok(
      lists.some((l) => l.failsLoud),
      `no handler matched '${FAILS_LOUD}' — if the error code was renamed, rename it HERE too rather than deleting the check.`,
    );
  });

  /* THE HOLE THAT WAS WALKED PAST, pinned — both halves of it. The first
     version kept one result per FILE and tested the whole file's text, so a
     second list in an already-registered file inherited the first one's guard,
     and a guard that had been reduced to a comment still read as present. */
  test("the scan returns EVERY list in a file, and a comment is not a guard", () => {
    const twoHandlersOneFile = [
      "grns.get('/', async (c) => {",
      "  if (countError) return c.json({ error: 'status_counts_failed' }, 500);",
      "  return c.json({ grns, total, page, pageSize, statusCounts });",
      "});",
      "",
      "grns.get('/probe-second-list', async (c) => {",
      "  const statusCounts = { all: count ?? 0 };",
      "  return c.json({ grns: [], total, page, pageSize, statusCounts });",
      "});",
    ].join("\n");
    const parsed = scanStatusCountLists(twoHandlersOneFile);
    assert.deepEqual(
      parsed.map((p) => [p.handler, p.failsLoud]),
      [["grns.get('/')", true], ["grns.get('/probe-second-list')", false]],
    );

    const guardIsOnlyAComment = [
      "grns.get('/', async (c) => {",
      "  // TODO: one day return status_counts_failed here",
      "  return c.json({ grns, total, page, pageSize, statusCounts });",
      "});",
    ].join("\n");
    assert.deepEqual(
      scanStatusCountLists(guardIsOnlyAComment).map((p) => p.failsLoud),
      [false],
      "a guard that exists only inside a comment must not read as a guard",
    );

    /* The contract is routinely written over several lines; matching it line by
       line would silently shrink the population to nothing. */
    const contractAcrossLines = [
      "grns.get('/', async (c) => {",
      "  return c.json({",
      "    grns, total, page,",
      "    pageSize, statusCounts,",
      "  });",
      "});",
    ].join("\n");
    assert.equal(scanStatusCountLists(contractAcrossLines).length, 1);

    /* A guard belonging to a top-level HELPER must not answer for a list in the
       handler that follows it — the file-level hole, one scope smaller. */
    const helperBetweenHandlers = [
      "async function loadCounts(c) {",
      "  if (countError) return c.json({ error: 'status_counts_failed' }, 500);",
      "}",
      "",
      "grns.get('/second', async (c) => {",
      "  return c.json({ grns: [], total, page, pageSize, statusCounts });",
      "});",
    ].join("\n");
    assert.deepEqual(
      scanStatusCountLists(helperBetweenHandlers).map((p) => [p.handler, p.failsLoud]),
      [["grns.get('/second')", false]],
    );
  });
});

describe("a count that could not be read is never served as a number", () => {
  for (const { key, rel, line, failsLoud } of lists) {
    test(`${key} answers a failed count with ${FAILS_LOUD}`, () => {
      assert.ok(
        failsLoud,
        `${rel}:${line} serves filter-pill statusCounts on the paginated list contract but its own handler `
        + `never returns `
        + `'${FAILS_LOUD}'. A count read that FAILS returns a null count / null data, and \`count ?? 0\` or `
        + `\`data ?? []\` turns that into an EMPTY bucket: a zero on the tab, no error in the response, `
        + `nothing in the log, and rows the operator can reach from no tab at all. Route the read through `
        + `readStatusCounts() or tallyStatusRows() in src/scm/lib/status-counts.ts and return `
        + `500 { error: '${FAILS_LOUD}' }. A legitimately EMPTY bucket still passes through as 0 — that is a `
        + `successful read of zero rows, and both helpers keep it. Another handler in the same file having `
        + `the guard does NOT satisfy this: the marker is looked for inside THIS handler's own block, and a `
        + `mention inside a comment is not a guard.`,
      );
    });
  }
});
