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
    expect(DESKTOP).not.toMatch(/const LEDGER_(COST|INCOME)_CATS\s*=/);
    expect(MOBILE).not.toMatch(/const LEDGER_(COST|INCOME)_CATS\s*=/);
  });

  test("a ledger category LABEL function is declared in neither", () => {
    expect(DESKTOP).not.toMatch(/function catLabel\s*\(/);
    expect(MOBILE).not.toMatch(/humanize\(\s*(line|l)\.category/);
  });

  test("the reviewable-title rule is declared in neither", () => {
    expect(DESKTOP).not.toMatch(/const REVIEWABLE_TITLES\s*=/);
    expect(MOBILE).not.toMatch(/const REVIEWABLE_TITLE_RE\s*=/);
  });

  test("the project status OPTION LIST is declared in neither", () => {
    expect(DESKTOP).not.toMatch(/value: "confirmed"/);
    expect(DESKTOP).not.toMatch(/value: "cancelled"/);
    expect(MOBILE).not.toMatch(/<option value="confirmed">/);
  });

  test("the payment pill labels are declared in neither", () => {
    for (const [name, src] of SURFACES) {
      expect(src, name).not.toMatch(/\["fully_paid",\s*"(Fully paid|Paid)"\]/);
    }
  });
});
