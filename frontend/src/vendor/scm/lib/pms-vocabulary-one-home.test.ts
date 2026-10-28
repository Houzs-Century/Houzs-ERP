/* The third copy must fail.
 *
 * Three PMS vocabularies were hand-written on BOTH surfaces, and all three had
 * either already drifted or were one edit away from it:
 *
 *   1. LEDGER CATEGORY LABELS. Desktop `catLabel()` mapped the ledger slugs
 *      explicitly; mobile ran a generic `humanize()` over every finance and
 *      sales line. The same P&L row read "COGS — Matt/Sofa" on the PC and
 *      "Cogs Matt Sofa" on the phone — two people reading one P&L read
 *      different category names. ALREADY DRIFTED.
 *   2. REVIEWABLE TITLES. Desktop was a Set of seven EXACT titles tested with
 *      `.has()`; mobile a PREFIX regex whose comment claimed it "mirrors" the
 *      desktop set. It is strictly broader, so "3D Design (Revision 2)" got the
 *      approve/reject workflow on the phone and NO review controls on the PC.
 *      ALREADY DRIFTED.
 *   3. PROJECT STATUS + PAYMENT PILLS. Status values agreed; the payment pill
 *      label did not — "Fully paid" on desktop, "Paid" on mobile. ALREADY
 *      DRIFTED, and the status list was one added status away from joining it.
 *
 * WHY A SOURCE SCAN AND NOT ONLY A BEHAVIOUR TEST. The sibling modules'
 * behaviour is pinned by pms-vocabulary.test.ts, and that is the easy half.
 * Every one of these copies was written by someone who needed a word in a
 * surface that could not reach the one that already had it — so the way this
 * returns is a call site quietly growing its own table again, which renders
 * fine and errors nowhere. Only the source shows it. Same shape as
 * backend/tests/assrStageLabelOneHome.test.ts, and as pms-status.ts, which
 * already did exactly this for the STAGE vocabulary.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const SRC = resolve(HERE, "../../..");

const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const DESKTOP = read("pages/Projects.tsx");
const MOBILE = read("mobile/MobilePMS.tsx");

const SURFACES: Array<[string, string]> = [
  ["desktop pages/Projects.tsx", DESKTOP],
  ["mobile mobile/MobilePMS.tsx", MOBILE],
];

describe("both PMS surfaces reach the shared vocabulary", () => {
  test.each(SURFACES)("%s imports the ledger category labels", (_name, src) => {
    expect(src).toMatch(/from "[^"]*pms-ledger-categories"/);
  });

  test.each(SURFACES)("%s imports the reviewable-title rule", (_name, src) => {
    expect(src).toMatch(/from "[^"]*pms-reviewable-titles"/);
  });

  test.each(SURFACES)("%s imports the project status vocabulary", (_name, src) => {
    expect(src).toMatch(/from "[^"]*pms-project-status"/);
  });
});

describe("neither surface keeps its own copy", () => {
  test("the ledger category LIST is declared in neither", () => {
    // Desktop's `const LEDGER_COST_CATS = [` / `LEDGER_INCOME_CATS = [`.
    expect(DESKTOP).not.toMatch(/const LEDGER_(COST|INCOME)_CATS\s*=/);
    expect(MOBILE).not.toMatch(/const LEDGER_(COST|INCOME)_CATS\s*=/);
  });

  test("a ledger category LABEL function is declared in neither", () => {
    expect(DESKTOP).not.toMatch(/function catLabel\s*\(/);
    // The mobile drift itself: a generic humanize standing in for the labels.
    expect(MOBILE).not.toMatch(/humanize\(\s*(line|l)\.category/);
  });

  test("the reviewable-title rule is declared in neither", () => {
    expect(DESKTOP).not.toMatch(/const REVIEWABLE_TITLES\s*=/);
    expect(MOBILE).not.toMatch(/const REVIEWABLE_TITLE_RE\s*=/);
  });

  test("the project status OPTION LIST is declared in neither", () => {
    // Deriving the list from the shared one is fine; re-typing the values is not.
    expect(DESKTOP).not.toMatch(/value: "confirmed"/);
    expect(DESKTOP).not.toMatch(/value: "cancelled"/);
    // Mobile's three literal <option> elements.
    expect(MOBILE).not.toMatch(/<option value="confirmed">/);
  });

  test("the payment pill labels are declared in neither", () => {
    // The drifted pair: "Fully paid" vs "Paid" for the same `fully_paid` value.
    for (const [name, src] of SURFACES) {
      expect(src, name).not.toMatch(/\["fully_paid",\s*"(Fully paid|Paid)"\]/);
    }
  });
});
