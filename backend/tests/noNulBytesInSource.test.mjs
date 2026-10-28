/* No tracked source file may contain a RAW NUL byte.

   WHY THIS IS NOT COSMETIC. `backend/scripts/merge-duplicate-fabric-colours.mjs`
   carried one at byte 7202 — a deliberate key separator, written as the byte
   itself instead of the two-character escape:

       const k = `${r.fabric_id}<NUL>${canonId(p)}`;

   Git classifies a blob with a NUL as BINARY. Measured, not assumed: appending
   one line to that file gave `git diff --numstat` -> `-  -`, and
   `gh pr diff` showed only "Binary files differ". So a 280-line tool that
   repoints fabric colours across fifteen line tables and eight stock tables ON
   PRODUCTION was merged with no reviewable diff, its PR reported 0 additions
   for it, and `git grep` answers "Binary file matches" with no content — it is
   invisible to every future audit that greps the tree.

   The escape `\0` is the same byte at runtime and keeps the file text: after
   the fix the same appended line reported `2  0`.

   node:test, no dependencies — the backend vitest suite runs in workerd and
   cannot read the filesystem. Wired into `npm run test:scale-contract`. */
import { test } from 'vitest';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** Extensions where a NUL is always a mistake. Deliberately not a deny-list of
 *  binary types: an unexpected new binary extension should be reviewed, not
 *  silently exempted, and an allow-list makes that visible. */
const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql", ".md", ".yml", ".yaml", ".css", ".html", ".sh", ".cs"]);

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1e8 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

test("git ls-files answers, so this check cannot pass by scanning nothing", () => {
  const files = tracked();
  assert.ok(files.length > 500, `only ${files.length} tracked files — the scan is broken, not the tree`);
});

/* TIMEOUT IS DECLARED, and it is not padding a slow test.
   This reads EVERY tracked source file — ~2,000 synchronous reads whose cost
   scales with the repo and with whatever else is competing for the disk, not
   with any logic here. It ran under `node --test`, which has NO default timeout,
   until BUG-HISTORY #2180 made it a vitest file; vitest's default is 5,000ms,
   a UNIT-test budget, and the conversion imposed it silently.

   Measured on Windows 2026-08-14: 3.47s alone — 70% of the default before any
   contention — and `Test timed out in 5000ms` in two of six full-suite runs,
   where 287 other files are reading at the same time. It failed as a flake, and
   a flake on a whole-tree gate reads as "the tree is dirty", which is the one
   thing it must never say by accident.

   Raising vitest's global testTimeout was the wrong lever: it would hand the
   same slack to 288 files and hide a genuinely hung unit test. The budget
   belongs on the test that legitimately needs it. 60s leaves room for heavy
   contention while still failing a real hang. */
test("no tracked source file contains a raw NUL byte", () => {
  const offenders = [];
  for (const rel of tracked()) {
    if (!SOURCE.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }   // deleted in the index, or a symlink
    const at = buf.indexOf(0);
    if (at >= 0) offenders.push(`${rel} (first at byte ${at} of ${buf.length})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these are binary to git, so their diffs are unreviewable and git grep cannot read them.\n` +
      `Write the escape (\\0) instead of the byte:\n  ${offenders.join("\n  ")}`,
  );
}, 60_000);
