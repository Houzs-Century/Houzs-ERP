/* The two derived-doc checks must separate a DEAD GENERATOR from DRIFTED OUTPUT.

   Both mirror something every pull request is required to change:
   `bug-index.md` mirrors BUG-HISTORY.md, which the working agreement makes
   every code PR append to, and `codebase-map-facts.md` embeds LINE NUMBERS,
   which move on every backend merge. main-protection makes merges strictly
   serial, so the instant one PR merges the file is stale on every other open
   PR — through no act of their authors.

   Measured 2026-08-14: five PRs failed `audit:bug-index` simultaneously on
   "175 entries", were regenerated one by one, and were stale again after the
   next merge. That is a deadlock wearing a gate's clothes.

   What the gate is FOR is the other failure: docs/staging-bench-rot-coe.md
   records `audit:map` crashing unnoticed for three weeks. A generator that
   produces nothing must still fail, loudly, and these tests pin that it does.

   node:test, no dependencies — run by `npm run test:scale-contract`. */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const read = (f) => fs.readFileSync(path.join(SCRIPTS, f), "utf8");

const GENERATORS = ["gen-bug-index.mjs", "gen-codebase-map.mjs"];

test("drift does not exit non-zero, and says so in the message", () => {
  for (const g of GENERATORS) {
    const src = read(g);
    assert.match(src, /--strict/, `${g}: drift must stay failable on demand via --strict`);
    assert.match(src, /NOT failing the run/, `${g}: the drift message must say it is not charging the author`);
  }
});

test("a generator that produced nothing still fails, with exit 2", () => {
  /* exit 2 is this repo's "refusing to answer" code — the same one the
     file-size gate uses for an empty scan. A check that reports success on an
     empty measurement is the failure it is supposed to catch. */
  assert.match(read("gen-bug-index.mjs"), /entries\.length === 0[\s\S]*?process\.exit\(2\)/,
    "gen-bug-index: zero parsed entries must exit 2");
  assert.match(read("gen-codebase-map.mjs"), /routeTotals\.modules \|\| !desktopRoutes\.length[\s\S]*?process\.exit\(2\)/,
    "gen-codebase-map: an empty scan must exit 2");
});

test("neither check exits 1 on drift alone", () => {
  /* The narrow property: inside the checkOnly branch, the only process.exit(1)
     left must be guarded by --strict. Read as source rather than executed,
     because executing them needs the whole repo and this must stay cheap.

     SLICED FROM THE BRANCH, not from the declaration. This read
     `src.indexOf("checkOnly")`, which is the `const checkOnly = …` line near the
     top — so "the check path" was every line in the file after line ~19, and the
     assertion did not match its own comment. Measured 2026-08-14: it failed a
     `process.exit(1)` that refuses an UNKNOWN `<!-- area: -->` tag, ~140 lines
     ABOVE the branch. That exit is right and must stay: the deadlock this test
     exists to prevent comes from DRIFT, which another author's merge causes, and
     a malformed tag is in the diff of whoever wrote it. `if (checkOnly)` is
     asserted to exist first, so a rename cannot silently empty the slice.

     >>> CORRECTED 2026-08-17. The last clause — "a malformed tag is in the diff
     of whoever wrote it" — is FALSE, and it cost a repo-wide CI blackout. The
     tag lives in BUG-HISTORY.md, the one file every code PR must append to, so
     once a bad tag MERGES it is in everybody's tree. Commit 6c9f8cbd landed one
     at 04:00:21Z; until #2351 repaired it at 04:59:53Z, five of five PR-branch
     CI runs were red and three of those branches had nothing to do with it —
     and because the generator exited before writing, nobody could regenerate
     their way out either. `gen-bug-index.mjs` now charges a bad tag only to the
     change that INTRODUCED it, exactly as check-file-size.mjs does for an
     inherited ceiling violation. The behavioural test below pins that. This
     assertion is unaffected: that exit still is not in the checkOnly branch. */
  for (const g of GENERATORS) {
    const src = read(g);
    const at = src.indexOf("if (checkOnly)");
    assert.ok(at >= 0, `${g}: no \`if (checkOnly)\` branch found — this guard is reading the wrong shape, not passing.`);
    const body = src.slice(at);
    for (const m of body.matchAll(/process\.exit\(1\)/g)) {
      const before = body.slice(Math.max(0, m.index - 400), m.index);
      assert.match(before, /--strict/, `${g}: an exit(1) in the check path that --strict does not guard`);
    }
  }
});

/* ---------------------------------------------------------------------------
   A BAD `<!-- area: -->` TAG MUST BLAME THE CHANGE THAT INTRODUCED IT.

   Run against a purpose-built repo rather than by matching source, because the
   property is about what the generator DOES with a merge base — and the last
   time this was asserted by reading source, the source-shape assertion passed
   while the behaviour caused an hour of repo-wide red.

   `audit:bug-index` runs inside `backend-typecheck`, which IS a required status
   check, so this is the difference between one author fixing their typo and
   every open PR being blocked. --------------------------------------------- */

const GOOD_TAG = "Repo tooling: tests, ratchets, generators";

function scratchLedgerRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugindex-"));
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "backend", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "generated"), { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS, "gen-bug-index.mjs"), path.join(dir, "backend", "scripts", "gen-bug-index.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { dir, git };
}

const entry = (title, tag) => `## ${title} [low]\n\n<!-- area: ${tag} -->\n\n**Symptom.** x.\n`;

function runGenerator(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, "backend", "scripts", "gen-bug-index.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status, err: r.stderr ?? "" };
}

test("a bad area tag INHERITED from the merge base is reported, not charged", (t) => {
  const { dir, git } = scratchLedgerRepo(t);
  const ledger = path.join(dir, "BUG-HISTORY.md");

  fs.writeFileSync(ledger, entry("Someone else's entry", "Not An Area") + "\n" + entry("Ordinary", GOOD_TAG));
  git("add", "-A"); git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  // This branch appends a perfectly clean entry of its own.
  fs.writeFileSync(ledger, entry("My entry", GOOD_TAG) + "\n" + fs.readFileSync(ledger, "utf8"));
  git("add", "-A"); git("commit", "-qm", "mine");

  const r = runGenerator(dir);
  assert.equal(r.status, 0, `inherited bad tag must NOT fail the run:\n${r.err}`);
  assert.match(r.err, /NOT charged to this change/);
  assert.match(r.err, /Someone else's entry/);
  // ...and the index must still BUILD, so the author can regenerate.
  assert.ok(fs.existsSync(path.join(dir, "docs", "generated", "bug-index.md")),
    "an inherited bad tag must not stop the generator writing its output");
});

test("...but a bad area tag this change INTRODUCES still fails, exit 1", (t) => {
  const { dir, git } = scratchLedgerRepo(t);
  const ledger = path.join(dir, "BUG-HISTORY.md");

  fs.writeFileSync(ledger, entry("Ordinary", GOOD_TAG));
  git("add", "-A"); git("commit", "-qm", "clean base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  fs.writeFileSync(ledger, entry("My typo", "Not An Area") + "\n" + fs.readFileSync(ledger, "utf8"));
  git("add", "-A"); git("commit", "-qm", "mine");

  const r = runGenerator(dir);
  assert.equal(r.status, 1, "a tag introduced by this change must fail");
  assert.match(r.err, /this change adds 1 entr/);
  assert.match(r.err, /My typo/);
});

test("with the tag broken on main AND a second added here, only MINE is charged", (t) => {
  const { dir, git } = scratchLedgerRepo(t);
  const ledger = path.join(dir, "BUG-HISTORY.md");

  fs.writeFileSync(ledger, entry("Theirs", "Not An Area") + "\n" + entry("Ordinary", GOOD_TAG));
  git("add", "-A"); git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  fs.writeFileSync(ledger, entry("Mine", "Not An Area") + "\n" + fs.readFileSync(ledger, "utf8"));
  git("add", "-A"); git("commit", "-qm", "mine");

  const r = runGenerator(dir);
  assert.equal(r.status, 1);
  /* The identity matters, not just the verdict: counting tag STRINGS gets the
     exit code right and names whichever entry happens to come second. */
  assert.match(r.err, /this change adds 1 entr[\s\S]*"Mine"/, "the charged entry must be the one this change added");
  assert.match(r.err, /NOT charged to this change[\s\S]*"Theirs"/, "the inherited entry must be reported, not charged");
});

test("an unresolvable merge base charges everything — a gate that cannot tell must not pass", (t) => {
  const { dir, git } = scratchLedgerRepo(t);
  const ledger = path.join(dir, "BUG-HISTORY.md");

  fs.writeFileSync(ledger, entry("Theirs", "Not An Area") + "\n" + entry("Ordinary", GOOD_TAG));
  git("add", "-A"); git("commit", "-qm", "only commit");
  // No refs/remotes/origin/main at all.

  const r = runGenerator(dir);
  assert.equal(r.status, 1, "with no merge base, a bad tag must be charged");
  assert.match(r.err, /cannot tell whose fault it is/);
});
