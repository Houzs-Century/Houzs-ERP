import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signoffCompanyCode } from "../src/routes/assr_print";

/**
 * The service form's sign-off names the company on the letterhead.
 *
 * A 2990 case printed with the HOUZS letterhead came out headed Houzs Century
 * while page 2 said "Goods received from 2990 HOME", "2990 HOME Representative"
 * and "2990 HOME Contact". The letterhead followed ?entity=, but the sign-off
 * name and CS phone were still read from the case's own company.
 */
describe("signoffCompanyCode", () => {
  test("a 2990 case printed on Houzs paper signs as Houzs", () => {
    expect(signoffCompanyCode("houzs", "2990")).toBe("HOUZS");
  });

  test("a Houzs case printed on 2990 paper signs as 2990", () => {
    expect(signoffCompanyCode("2990", "HOUZS")).toBe("2990");
  });

  test("both heads with Houzs, so Houzs signs", () => {
    expect(signoffCompanyCode("both", "2990")).toBe("HOUZS");
    expect(signoffCompanyCode("both", "HOUZS")).toBe("HOUZS");
  });

  test("the case's own entity keeps the case's company", () => {
    expect(signoffCompanyCode("houzs", "HOUZS")).toBe("HOUZS");
    expect(signoffCompanyCode("2990", "2990")).toBe("2990");
  });
});

const REPO_BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the printed sign-off reads the signing company", () => {
  const src = fs.readFileSync(path.join(REPO_BACKEND, "src/routes/assr_print.ts"), "utf8");

  test("coShort and csPhone come from the sign-off company, not the case's", () => {
    expect(src).toMatch(/const signCode = signoffCompanyCode\(entity, companyCode\)/);
    expect(src).toMatch(/const coShort = shortCompanyName\(signBranding\.companyName\)/);
    expect(src).toMatch(/const csPhone = signCode === HOUZS_COMPANY_CODE/);
    expect(src).not.toMatch(/shortCompanyName\(branding\.companyName\)/);
  });
});
