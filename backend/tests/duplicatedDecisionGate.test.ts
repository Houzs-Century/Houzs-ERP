/* A BUSINESS RULE MAY NOT HAVE TWO HOMES AND NO REFEREE — the gate, and the
   proof it bites.

   Modelled on tests/emptyStateClaimGate.test.ts, for the same reason that file
   gives: a gate nobody has watched fail is a gate that may be scanning nothing.
   check-trgm-coverage.mjs sat in this repo with BOTH exit paths at exit 0 and
   in no workflow at all, and read as a pass for weeks.

   WHAT THIS PINS, and why each is here rather than trusted:

     1. THE GATE PASSES on the tree as committed.
     2. IT FAILS ON A PLANTED D1 — a set of values given a second home under a
        different name. The plant goes in a temp directory OUTSIDE the source
        tree (DUPLICATED_DECISIONS_EXTRA_ROOT), so proving the gate never
        requires writing a duplicate into src.
     3. IT FAILS ON A PLANTED D2 — a NEAR MISS, one member off. This is the
        detector that matters most: it is what sees a rule enforced at N-1 of N
        places, and it is the one whose threshold is easiest to get wrong.
     4. IT DOES NOT FIRE ON AN HONEST FILE, or the next person deletes the gate
        instead of the duplicate.
     5. THE ALLOWLIST CARRIES REASONS. An allowlist of bare keys is a mute
        button.

   D3 is deliberately NOT proved from a temp directory: its config names real
   route files by path, so the honest proof is the one in the PR body — the
   guard call was deleted from ONE of the two guarded handlers in
   mfg-sales-orders.ts and the gate reported that handler while the guard was
   still present twice elsewhere in the same file. What IS asserted here is that
   D3 is actually looking at something: the run must report a non-zero number of
   CHECKED handlers, because "0 missing out of 0" is exactly how a checker looks
   clean while seeing nothing. */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "backend", "scripts", "check-duplicated-decisions.mjs");
const ALLOWLIST = path.join(ROOT, "backend", "scripts", "data", "duplicated-decision-allowlist.json");

function run(extraRoot?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--strict"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: extraRoot ? { ...process.env, DUPLICATED_DECISIONS_EXTRA_ROOT: extraRoot } : process.env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/* Each of these SPAWNS the checker, which walks ~1,100 source files. */
const SPAWN_TIMEOUT_MS = 120_000;

describe("the duplicated-decision gate", () => {
  test("passes on the tree as committed", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const { code, out } = run();
    expect(out).toContain("source files scanned");
    expect(code, out.slice(-3000)).toBe(0);
  });

  test("D3 is looking at real handlers, not at nothing", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const { out } = run();
    const m = out.match(/D3 guard missing from a handler\s*:\s*(\d+) of (\d+) checked handler/);
    expect(m, `the D3 summary line was not printed:\n${out.slice(0, 2000)}`).not.toBeNull();
    expect(Number(m![2]), "D3 checked ZERO handlers — its handlerPattern matches nothing").toBeGreaterThan(0);
  });

  /* THE NON-VACUITY PROOF. Exit 2 is the script's own self-test failing and
     must never be read as a caught violation — a checker that cannot run is not
     a checker that found nothing. */
  test("FAILS on a planted D1 duplicate, and passes again once it is gone", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dup-decision-gate-"));
    try {
      // TWO files, because D1's rule is a fingerprint carried by two or more
      // FILES. One file with the set twice is not the defect being hunted.
      fs.writeFileSync(
        path.join(dir, "plantedRuleA.ts"),
        "export const PLANTED_REFUSED = new Set(['PLANTED_ALPHA', 'PLANTED_BETA', 'PLANTED_GAMMA']);\n",
      );
      fs.writeFileSync(
        path.join(dir, "plantedRuleB.ts"),
        "export const PLANTED_BLOCKED = ['PLANTED_GAMMA', 'PLANTED_ALPHA', 'PLANTED_BETA'] as const;\n",
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("NOT REVIEWED — D1");
      expect(bad.out).toContain("PLANTED_ALPHA");
      // The order the members were written in must not matter — that is the
      // whole point of a canonicalised fingerprint.
      expect(bad.out).toContain("plantedRuleA.ts");
      expect(bad.out).toContain("plantedRuleB.ts");

      fs.rmSync(path.join(dir, "plantedRuleB.ts"));
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS on a planted D2 near miss — one member off", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dup-decision-near-"));
    try {
      fs.writeFileSync(
        path.join(dir, "nearA.ts"),
        "export const NEAR_ONE = ['NEAR_A', 'NEAR_B', 'NEAR_C', 'NEAR_D'];\n",
      );
      fs.writeFileSync(
        path.join(dir, "nearB.ts"),
        "export const NEAR_TWO = ['NEAR_A', 'NEAR_B', 'NEAR_C', 'NEAR_D', 'NEAR_E'];\n",
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("NOT REVIEWED — D2");
      // The report must name the DIFFERING member — a near-miss report that
      // does not say what differs sends the reader back to the source.
      expect(bad.out).toMatch(/only in [AB]: NEAR_E/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not fire on a file whose sets are its own", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dup-decision-ok-"));
    try {
      fs.writeFileSync(
        path.join(dir, "honest.ts"),
        // A set nothing else in the tree carries, a two-member set (below the
        // floor), a numeric array and a camelCase prop bag: none is a hit.
        "export const ONLY_HOME = ['SOLO_ONE', 'SOLO_TWO', 'SOLO_THREE'];\n" +
          "export const PAIR = ['SOLO_FOUR', 'SOLO_FIVE'];\n" +
          "export const NUMS = [1, 2, 3];\n" +
          "export const BAG = { itemCode: 'a', unitPrice: 'b', qtyOrdered: 'c' };\n",
      );
      const { code, out } = run(dir);
      expect(code, out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reviewed allowlist", () => {
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")) as {
    reviewed: Array<{ check: string; key: string; why: string }>;
  };

  test("every entry names a detector, a key, and a reason", () => {
    expect(doc.reviewed.length).toBeGreaterThan(0);
    for (const e of doc.reviewed) {
      expect(["D1", "D2", "D3"], JSON.stringify(e).slice(0, 200)).toContain(e.check);
      expect(typeof e.key, JSON.stringify(e).slice(0, 200)).toBe("string");
      expect(e.key.length, "an empty key silences everything it matches").toBeGreaterThan(0);
      // Long enough to be a sentence. A placeholder is not a review.
      expect(e.why.trim().length, `${e.key.slice(0, 80)}: the reason is too short to be one`).toBeGreaterThan(30);
      expect(e.why, `${e.key.slice(0, 80)}: placeholder reason`).not.toMatch(/^TODO|\bTBD\b|^n\/?a$/i);
    }
  });

  test("no duplicate entries — a second copy is a second mute button", () => {
    const keys = doc.reviewed.map((e) => `${e.check}|${e.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the pins referenced by a reason actually exist", () => {
    // A `why` that points at a test is only worth anything if the test is real.
    const cited = doc.reviewed.filter((e) => /duplicatedDecisionPins|passwordStrengthDrift/.test(e.why));
    expect(cited.length, "no allowlist entry cites a pin — the two mechanisms have come apart").toBeGreaterThan(0);
    for (const f of ["duplicatedDecisionPins.test.ts", "passwordStrengthDrift.test.ts"]) {
      expect(fs.existsSync(path.join(ROOT, "backend", "tests", f)), `${f} is cited but missing`).toBe(true);
    }
  });
});
