import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The 31st copy must fail.
 *
 * `docs/bug-classes.md` class F — "One rule, N hand-written copies", 61 entries —
 * is listed there WITHOUT a check, and says why: the general version is
 * byte-equality over the 18 `backend/src/scm/shared/` ↔ `frontend/src/vendor/shared/`
 * pairs, 11 of which differ today, and nothing yet distinguishes a deliberate
 * difference from a regression. That triage is its own piece of work.
 *
 * This is the narrow version, and it is exact. `stage != 'completed'` named ONE
 * of the two terminal service-case stages; roughly thirty copies of it meant a
 * VOIDED case stayed in the backlog, kept aging, kept breaching its SLA and kept
 * mailing the assignee and every manager. All of them now call
 * `assrOpenStageSql` (`src/services/assrStages.ts`). Within the three files that
 * own the open/closed question, the literal is banned outright — a reviewer
 * cannot be relied upon to notice copy 31, which is the entire lesson of the
 * class.
 *
 * The CLOSED side (`stage = 'completed'`) is deliberately NOT banned: it drives
 * the resolved counts and the average-resolution-time figures, and a voided case
 * was not resolved.
 */
const REPO_BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OWNS_THE_QUESTION = [
  "src/routes/assr.ts",
  "src/services/assr.ts",
  "src/services/assrEscalation.ts",
];

const HAND_COPY = /stage\s*(?:!=|<>)\s*'completed'/;

describe("the service-case open predicate has exactly one home", () => {
  test("the scan can see the shape it bans", () => {
    // A guard that cannot fail is class D. Pin the pattern against both spellings
    // the corpus actually used, so a silently-broken regex cannot report a pass.
    expect(HAND_COPY.test("WHERE c.stage != 'completed'")).toBe(true);
    expect(HAND_COPY.test("WHERE c.stage <> 'completed'")).toBe(true);
    expect(HAND_COPY.test("SUM(CASE WHEN stage != 'completed' THEN 1 ELSE 0 END)")).toBe(true);
    expect(HAND_COPY.test("stage = 'completed'")).toBe(false);
  });

  test("the files it scans exist — a moved path must not pass in silence", () => {
    for (const rel of OWNS_THE_QUESTION) {
      expect(fs.existsSync(path.join(REPO_BACKEND, rel)), `${rel} is missing`).toBe(true);
    }
  });

  test("no file re-types the predicate instead of calling assrOpenStageSql", () => {
    const offenders: string[] = [];
    for (const rel of OWNS_THE_QUESTION) {
      const text = fs.readFileSync(path.join(REPO_BACKEND, rel), "utf8");
      text.split("\n").forEach((line, i) => {
        if (HAND_COPY.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("and every one of them actually calls the helper", () => {
    for (const rel of OWNS_THE_QUESTION) {
      const text = fs.readFileSync(path.join(REPO_BACKEND, rel), "utf8");
      expect(text, `${rel} does not use assrOpenStageSql`).toContain("assrOpenStageSql");
    }
  });
});
