import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sixth copy must fail.
 *
 * The ASSR stage vocabulary was hand-written in five places, and the copy a
 * CUSTOMER reads was the one that never got `voided`. `customerStatusFor`
 * (services/caseTracking.ts) was a switch over nine stages plus six legacy
 * aliases ending `default: { label: stage }`, so the portal printed the raw
 * database slug — and portal.ts builds the salesperson stepper by mapping
 * ALL_STAGES through it, so the slug was a STEP LABEL on every sales-portal
 * view, not only on voided cases. Meanwhile assr_print.ts said
 * "Voided — Not Valid" and the sheet export said "Voided": three answers.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. assr-stage-labels.test.ts pins
 * what the shared table answers, and that is the easy half. Every one of the
 * five copies was written by someone who needed a word in a layer that could
 * not reach the one that already had it — so the way this returns is a call
 * site quietly growing its own table again, which renders fine and errors
 * nowhere. Only the source shows it. Same lesson, and same shape, as
 * assrOpenStageNoHandCopies.test.ts.
 *
 * IT LIVES IN tests/ AND NOT NEXT TO THE MODULE because backend/tsconfig.json
 * sets `types: ["@cloudflare/workers-types"]` and includes only `src/**`; a
 * test under src/ has no node:fs and cannot read a file at all.
 */
const REPO_BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [ what it is, path, the shared export it must reach ] */
const OWNS_THE_QUESTION: Array<[string, string, string]> = [
  ["the customer portal", "src/services/caseTracking.ts", "assrCustomerStatus"],
  ["the printed service report", "src/routes/assr_print.ts", "assrStageLabel"],
  ["the ops sheet export", "src/routes/assrFormIntake.ts", "ASSR_SHEET_STATUS"],
];

/** The words themselves. A local `pending_review: "Pending Review"` is how all
 *  five copies started, so the literal is banned in the files that own the
 *  question — a reviewer cannot be relied on to notice copy six. */
const BANNED_LABELS = [
  "Pending Review",
  "Under Verification",
  "Pending Solution",
  "Supplier Pickup / Return",
  "Pending Item Ready",
  "Voided — Not Valid",
];

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const read = (rel: string): string => fs.readFileSync(path.join(REPO_BACKEND, rel), "utf8");

describe("the ASSR stage vocabulary has exactly one home", () => {
  test("the scan can see the shape it bans", () => {
    // A guard that cannot fail is worse than no guard. Pin the matcher against
    // the exact form every copy took, and against a form it must NOT flag.
    const sample = stripComments('const M = {\n  pending_review: "Pending Review",\n};\n');
    expect(sample.includes('"Pending Review"')).toBe(true);
    // A label named in a comment is not a copy of the rule.
    expect(stripComments('// it used to say "Pending Review" here').includes('"Pending Review"'))
      .toBe(false);
    // Nor is the STAGE KEY, which these files legitimately still name.
    expect(stripComments('if (cs.stage === "pending_review") {').includes('"Pending Review"'))
      .toBe(false);
  });

  test("the files it scans exist — a moved path must not pass in silence", () => {
    for (const [, rel] of OWNS_THE_QUESTION) {
      expect(fs.existsSync(path.join(REPO_BACKEND, rel)), `${rel} is missing`).toBe(true);
    }
    expect(fs.existsSync(path.join(REPO_BACKEND, "src/scm/shared/assr-stage-labels.ts"))).toBe(true);
  });

  test("no file re-types a stage label instead of reading the shared table", () => {
    const offenders: string[] = [];
    for (const [, rel] of OWNS_THE_QUESTION) {
      const text = stripComments(read(rel));
      text.split("\n").forEach((line, i) => {
        for (const label of BANNED_LABELS) {
          if (line.includes(`"${label}"`)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("and every one of them actually reads the shared table", () => {
    for (const [what, rel, symbol] of OWNS_THE_QUESTION) {
      const text = read(rel);
      expect(
        text.includes("scm/shared/assr-stage-labels"),
        `${rel} (${what}) no longer imports the shared table`,
      ).toBe(true);
      expect(text.includes(symbol), `${rel} (${what}) no longer uses ${symbol}`).toBe(true);
    }
  });

  test("portal.ts answers all three of its questions through customerStatusFor", () => {
    /* The three reads the customer's page is built from: the case header, the
       timeline's "Status updated to X", and the ALL_STAGES stepper. The stepper
       is the one that made this bug appear on every sales-portal view — if any
       of the three is ever answered another way, the slug is back. */
    const portal = read("src/routes/portal.ts");
    expect(portal.match(/customerStatusFor\(/g) ?? []).toHaveLength(3);
    expect(portal).toContain("label: customerStatusFor(s).label");
  });

  test("the shared table is at the path the mirror gate enumerates", () => {
    /* check-shared-mirrors.mjs reads backend/src/scm/shared with readdirSync —
       NON-recursively — and looks the same basename up in frontend/src/vendor/
       shared and frontend/src/vendor/scm/lib. Move either copy into a
       subdirectory and the gate stops refereeing the pair without saying so. */
    const fe = path.resolve(
      REPO_BACKEND,
      "../frontend/src/vendor/scm/lib/assr-stage-labels.ts",
    );
    expect(fs.existsSync(fe), "the frontend mirror is not where the gate looks").toBe(true);
    const norm = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    expect(norm(fe)).toBe(norm(path.join(REPO_BACKEND, "src/scm/shared/assr-stage-labels.ts")));
  });
});
