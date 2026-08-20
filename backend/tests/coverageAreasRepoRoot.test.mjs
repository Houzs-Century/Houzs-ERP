/* The coverage ratchet's REPO_ROOT must be the repository, and a Windows-only
   way of getting that wrong must fail on LINUX CI.

   WHAT HAPPENED. `scripts/coverage-areas.mjs` built REPO_ROOT from
   `new URL(import.meta.url).pathname`. A file URL's `pathname` is a URL path:
   on Windows it is `/C:/Users/...`, leading slash included, and `path.resolve`
   reads that slash as "absolute" and prefixes the current drive —

     REPO_ROOT = C:\C:\Users\User\Desktop\...\houzs-work

   Nothing under that exists. Every area scanned zero files and the committed
   `coverage-baseline.json` was simply not there, so the ratchet ran against no
   floors at all. Linux CI was unaffected, because a POSIX file URL's pathname
   already IS the path — which is the whole danger: the gate looked healthy in
   CI and was absent on the only OS this repo is developed on. Same class as the
   ESLint `.bin` shim, and as `coverage-ratchet.mjs`'s own `file://` entry-point
   bug two hundred lines from the break.

   WHY THIS TEST IS SHAPED THE WAY IT IS. A test that only asserts "REPO_ROOT
   exists" passes on Linux with the bug still in the file, and Linux is where CI
   runs — so it would guard nothing. The two guards therefore cover different
   platforms and neither is redundant:

     · on WINDOWS the module's own load-time self-test throws before any test
       runs — vitest cannot even load its config, which is the strongest form of
       "refuses to report rather than report from a dead one". Verified by
       reverting the line: the whole suite refuses with the doubled root printed.
     · on LINUX that self-test is satisfied (a POSIX file URL's pathname already
       IS the path), so the LAST test here is the guard: it reads the source and
       fails on any platform if `.pathname` comes back.

   The third test records the platform property that let the two disagree in the
   first place, and asserts the Windows half only where it is observable. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AREAS, REPO_ROOT, listAreaFiles } from "../../scripts/coverage-areas.mjs";

test("REPO_ROOT is the repository — the files that define it are under it", () => {
  for (const marker of ["package.json", "scripts/coverage-areas.mjs", "coverage-baseline.json"]) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, marker)),
      `REPO_ROOT=${REPO_ROOT} does not contain ${marker}. A ratchet that cannot find its own ` +
        `baseline compares every area against nothing and reports a pass.`,
    );
  }
});

test("every ratcheted area scans a non-zero number of files", () => {
  /* The count is deliberately not pinned — files land every day. ZERO is the
     only number that means the scan is broken, and it is the number the path
     bug produced for all six areas at once. */
  for (const area of AREAS) {
    assert.ok(
      listAreaFiles(area).length > 0,
      `area "${area.id}" scanned 0 files under ${REPO_ROOT}. An empty denominator is not a clean run.`,
    );
  }
});

test("only fileURLToPath round-trips a real path — asserted, not assumed", () => {
  /* Runs on both platforms, and on WINDOWS it is the bug itself: `pathname`
     does not round-trip, `fileURLToPath` does. On Linux the round-trip holds
     for both, which is precisely why the bug survived CI — so the Linux guard
     is the source assertion in the next test, and this one records the property
     that made the two disagree. */
  const self = path.join(REPO_ROOT, "scripts", "coverage-areas.mjs");
  const href = pathToFileURL(self).href;
  assert.equal(fileURLToPath(href), self, "fileURLToPath must round-trip a real path on every platform");

  if (process.platform === "win32") {
    assert.notEqual(
      new URL(href).pathname,
      self,
      "on Windows a file URL's pathname is NOT the path — if these are equal the premise changed",
    );
    assert.match(new URL(href).pathname, /^\/[A-Za-z]:\//, "pathname keeps the URL's leading slash before the drive");
    assert.equal(
      path.resolve(new URL("file:///C:/repo/scripts").pathname, ".."),
      path.resolve("/C:/repo"),
      "path.resolve reads that leading slash as absolute — this is the doubled drive letter",
    );
  }

  /* Percent-encoding, which bites on Linux too: a checkout under a path with a
     space arrives as `%20` from `pathname` and as a real space from
     `fileURLToPath`. */
  const spacey = pathToFileURL(path.join(REPO_ROOT, "my repo", "x.mjs")).href;
  assert.ok(new URL(spacey).pathname.includes("%20"), "pathname leaves the space percent-encoded");
  assert.ok(!fileURLToPath(spacey).includes("%20"), "fileURLToPath decodes it");
});

test("coverage-areas.mjs does not derive a path from a URL pathname", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "scripts/coverage-areas.mjs"), "utf8");
  /* COMMENTS STRIPPED BEFORE MATCHING. That file explains the bug by NAMING the
     broken expression, so a raw match fires on the explanation and this test
     fails on a correct tree — which is how it failed first time it was run. The
     rule this repo already applies in soProcessingDateOneName: match code. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/new URL\(import\.meta\.url\)\s*\.pathname/.test(code),
    "coverage-areas.mjs is back to `new URL(import.meta.url).pathname`. Use fileURLToPath.",
  );
  assert.ok(code.includes("fileURLToPath"), "coverage-areas.mjs no longer imports fileURLToPath.");
});
