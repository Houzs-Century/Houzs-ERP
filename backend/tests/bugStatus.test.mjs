/* A ledger entry's STATE must be readable by a command, not inferred from prose.

   WHY THIS EXISTS. On 2026-09-08 the owner said the same problems keep coming
   back after being "fixed for a long time" (「fix 了很久了 还是一样的问题」). The
   ledger is the memory that is supposed to prevent that, and it had no field
   saying whether an entry was still outstanding — so every session re-derived
   it by grepping prose, and got it wrong in BOTH directions:

     · A sweep for the word "unfixed" returned 138 files. 126 of them use it
       ONLY in this repo's TDD phrase "fails on the unfixed tree" — which is
       evidence a bug WAS fixed red-first, the exact opposite of a status.
     · Entries whose repair had been applied to production weeks earlier still
       opened with "planned but not applied", because nothing brought the writer
       back to the file after the run.

   Both are the same missing thing: a status the ledger states rather than
   implies. These tests pin it.

   node:test-shaped, dependency-free apart from the vitest runner. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUG_DIR, STATUS_VALUES, parseEntry, readEntries, readStatus } from "../scripts/lib/bug-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A throwaway ledger, so these tests never depend on what the real one happens to say today. */
function withLedger(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bug-status-"));
  fs.mkdirSync(path.join(dir, BUG_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, BUG_DIR, name), text);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the four states are exactly the ones a reader has to act on", () => {
  assert.deepEqual([...STATUS_VALUES].sort(), ["fixed", "open", "owner-decision", "superseded"]);
});

test("a status tag is read off the entry body, like the area tag beside it", () => {
  const e = parseEntry("## A title [high]\n\n<!-- area: Sales orders + pricing -->\n<!-- status: fixed -->\n\nbody\n");
  assert.equal(readStatus(e.body).status, "fixed");
});

test("the tag is case- and space-insensitive, because humans write it by hand", () => {
  assert.equal(readStatus("<!--status:OPEN-->").status, "open");
  assert.equal(readStatus("<!--   status:   Owner-Decision   -->").status, "owner-decision");
});

test("an entry with no tag reports null — NOT a guess, and never 'fixed'", () => {
  // The whole failure this feature exists to stop is a state being inferred.
  // An untagged entry is UNKNOWN, and the reporter must say so out loud.
  assert.equal(readStatus("## t\n\nbody with no tag\n").status, null);
});

test("a status nobody defined is REPORTED, not silently swallowed", () => {
  const r = readStatus("<!-- status: probably-fine -->");
  assert.equal(r.status, null);
  assert.equal(r.invalid, "probably-fine");
});

test("the word 'unfixed' in the TDD phrase is NOT a status", () => {
  // 113 occurrences of "unfixed tree" in the real ledger. Every one of them is a
  // fix being PROVED, and a reader that counts them as open backlog invents
  // ~126 phantom entries — which is exactly what happened.
  const body = "Proved RED against the unfixed tree; 15 tests, 14 failed.\n";
  assert.equal(readStatus(body).status, null);
  assert.equal(readStatus(body).invalid, null);
});

test("readEntries carries the status through, so one call answers 'what is open'", () => {
  const files = {
    "0001-done.md": "## Done [low]\n\n<!-- status: fixed -->\n\nbody\n",
    "0002-waiting.md": "## Waiting [high]\n\n<!-- status: owner-decision -->\n\nbody\n",
    "0003-silent.md": "## Silent [med]\n\nno tag at all\n",
  };
  withLedger(files, (dir) => {
    const { entries } = readEntries(dir);
    const by = Object.fromEntries(entries.map((e) => [e.ordinal, e.status]));
    assert.equal(by[1], "fixed");
    assert.equal(by[2], "owner-decision");
    assert.equal(by[3], null, "an untagged entry must stay null — inferring is the bug.");
  });
});

test("the real ledger still parses, and every tag it carries is a defined one", () => {
  const { entries } = readEntries(ROOT);
  assert.ok(entries.length > 400, `only ${entries.length} entries read — the reader is broken, not the ledger.`);
  const bad = entries.filter((e) => e.statusInvalid).map((e) => `${e.name}: ${e.statusInvalid}`);
  assert.deepEqual(bad, [], "an undefined status is invisible to every reader that filters on the defined ones.");
});
