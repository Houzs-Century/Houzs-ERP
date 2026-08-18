// check-company-scope.mjs — pin the three shapes it learned to see on
// 2026-08-18, and the delegation guard it stopped trusting.
//
// WHY A TEST AND NOT JUST THE SCRIPT'S OWN SELF-TESTS. The script asserts its
// REGEXES at startup and exits 2 rather than reporting from a dead pattern —
// that is the repo's standing rule and it is already there. What it cannot
// assert about itself is that the passes are still WIRED UP: a pass whose
// findings array is never pushed to, or a section that stops printing, leaves
// every regex passing and the report silently narrower again. That is exactly
// the failure this whole branch exists to correct — the script printed
// `0 of them WRITE` over fifteen live leaks — so it is worth a test that runs
// the real thing and reads the real output.
//
// Deliberately asserts SHAPE, not counts. A count here would be a number in a
// comment with an expiry date: it moves every time someone fixes or adds a
// handler, and a test that fails on a FIX is a test people delete.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backendRoot, "scripts", "check-company-scope.mjs");
/* Read through a PIPE deliberately. That is how CI and every `| grep` consumes
   it, and until 2026-08-18 it was ALSO how the report got silently truncated —
   the script ended on `process.exit()`, which tears the process down before an
   async stdout write drains. Reading it any other way would not have caught
   that, and would not catch it coming back. */
const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
const source = readFileSync(script, "utf8");

describe("check-company-scope reports the shapes ID_PREDICATE cannot see", () => {
  test("it ran at all — the self-tests refuse to report rather than report from a dead pattern", () => {
    // exit 2 is the "not reporting" path; execFileSync would have thrown.
    expect(out).toMatch(/^Checked \d+ SCM route handlers\./m);
  });

  test("the WHOLE report survives a pipe — no process.exit() truncation", () => {
    // The tail sections are the ones that vanished: they are last on stdout.
    expect(out).toContain("Library tree (src/scm/lib + src/scm/shared)");
    expect(source).not.toMatch(/^process\.exit\(/m);
    expect(source).toMatch(/^process\.exitCode = /m);
  });

  test("the three new sections are PRESENT and each names its rule", () => {
    expect(out).toContain("Shapes the by-id passes are BLIND to");
    expect(out).toMatch(/SET-READ\s+a list with no row narrowing and no company predicate/);
    expect(out).toMatch(/NATURAL-KEY\s+a write addressed by a key each company can hold its own of/);
    expect(out).toMatch(/UPSERT-KEY\s+an upsert whose onConflict target omits company_id/);
    expect(out).toMatch(/RPC\s+the predicate moved into a Postgres function this cannot read/);
  });

  test("each new pass is actually WIRED — it found at least one statement of its own kind", () => {
    // Not a count: just that the pass is connected to the report. Zero here
    // would mean the section prints and the pass does not run, which is the
    // exact "clean run computed over nothing" CLAUDE.md forbids.
    for (const kind of ["SET-READ", "NATURAL-KEY", "UPSERT-KEY", "RPC"]) {
      const section = out.slice(out.indexOf(`  ${kind}`));
      expect(section, `${kind} produced no rows`).toMatch(/\n {4}(WRITE|read )/);
    }
  });

  test("the SUPPRESSION LEDGER prints — a suppression nobody can see is one nobody re-checks", () => {
    expect(out).toMatch(/Suppressions — "\/\/ company-scope:" annotations that silenced a handler: \d+\./);
    // and it names them, rather than only counting them
    expect(out).toMatch(/\n {4}L\d+ {2}(GET|POST|PUT|PATCH|DELETE) \//);
  });

  test("salesDocOutOfScope is NOT a delegation guard — it has no company logic", () => {
    // scm/lib/salesScope.ts resolves a SALESPERSON subtree. Trusting it as a
    // company guard suppressed two real findings. The removal is recorded in
    // the script; this pins that nobody puts it back.
    const guards = source.slice(
      source.indexOf("const DELEGATION_GUARDS = ["),
      source.indexOf("/* SCOPE PRIMITIVES"),
    );
    const active = guards
      .split("\n")
      .filter((l) => /^\s*"/.test(l))
      .join("\n");
    expect(active).not.toContain("salesDocOutOfScope");
    // and the reason survives in the file, so the next reader does not re-add it
    expect(guards).toContain("salesDocOutOfScope");
  });

  test("--strict gates on the NEW writes too, not only the by-id ones", () => {
    expect(source).toMatch(
      /const writeFindings =\s*\n?\s*findings\.filter\(\(f\) => f\.writes\)\.length \+ shapeFindings\.filter\(\(f\) => f\.writes\)\.length;/,
    );
  });
});
