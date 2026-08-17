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
// paginated SCM list serving filter-pill counts, and the seventh one will be
// caught the day it is written. There is deliberately no exemption list — a
// suppression the reader cannot see is a suppression nobody re-checks.

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

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function findStatusCountLists() {
  const found = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("statusCounts")) continue;
    if (!LIST_CONTRACT.test(src)) continue;
    found.push({
      rel: path.relative(backendRoot, file).split(path.sep).join("/"),
      failsLoud: src.includes(FAILS_LOUD),
    });
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

const lists = findStatusCountLists();

describe("the checker itself", () => {
  test("the scan finds the paginated SCM lists, so the verdict is over something", () => {
    assert.ok(
      lists.length >= MIN_EXPECTED_LISTS,
      `found ${lists.length} paginated statusCounts lists, expected at least ${MIN_EXPECTED_LISTS}: `
      + `${lists.map((l) => l.rel).join(", ") || "(none)"}. The pattern is dead, not the codebase — `
      + `a verdict computed over nothing must never read as a pass.`,
    );
  });

  test("the LOUD marker is a real string in the tree, not a spelling nobody uses", () => {
    assert.ok(
      lists.some((l) => l.failsLoud),
      `no file matched '${FAILS_LOUD}' — if the error code was renamed, rename it HERE too rather than deleting the check.`,
    );
  });
});

describe("a count that could not be read is never served as a number", () => {
  for (const { rel, failsLoud } of lists) {
    test(`${rel} answers a failed count with ${FAILS_LOUD}`, () => {
      assert.ok(
        failsLoud,
        `${rel} serves filter-pill statusCounts on the paginated list contract but never returns `
        + `'${FAILS_LOUD}'. A count read that FAILS returns a null count / null data, and \`count ?? 0\` or `
        + `\`data ?? []\` turns that into an EMPTY bucket: a zero on the tab, no error in the response, `
        + `nothing in the log, and rows the operator can reach from no tab at all. Route the read through `
        + `readStatusCounts() or tallyStatusRows() in src/scm/lib/status-counts.ts and return `
        + `500 { error: '${FAILS_LOUD}' }. A legitimately EMPTY bucket still passes through as 0 — that is a `
        + `successful read of zero rows, and both helpers keep it.`,
      );
    });
  }
});
