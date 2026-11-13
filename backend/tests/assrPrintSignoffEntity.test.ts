import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docCodes, signoffCompanyCode } from "../src/routes/assr_print";

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

describe("docCodes keeps each document number on one line", () => {
  test("a PO number never breaks at its hyphens", () => {
    expect(docCodes("HC-PO-2609-116")).toBe('<span class="doc-code">HC-PO-2609-116</span>');
  });

  test("several numbers stay a comma list, each unbroken", () => {
    expect(docCodes("HC-PO-1, HC-PO-2")).toBe('<span class="doc-code">HC-PO-1</span>, <span class="doc-code">HC-PO-2</span>');
  });

  test("a dot-separated PO list keeps its dots and each number unbroken", () => {
    expect(docCodes("HC-PO-1 · HC-PO-2")).toBe('<span class="doc-code">HC-PO-1</span> · <span class="doc-code">HC-PO-2</span>');
  });

  test("an empty value prints a dash and markup is escaped", () => {
    expect(docCodes(null)).toBe("—");
    expect(docCodes("<b>")).toBe('<span class="doc-code">&lt;b&gt;</span>');
  });
});

describe("the office and customer copies print no empty placeholders", () => {
  const src = fs.readFileSync(path.join(REPO_BACKEND, "src/routes/assr_print.ts"), "utf8");

  test("a photo section with no photos is left out, never an Add box", () => {
    expect(src).not.toMatch(/class="add">＋ Add/);
    expect(src).toMatch(/\$\{issuePhotos\.length \? `/);
    expect(src).toMatch(/\$\{qcPhotos\.length \? `/);
  });

  test("the items table has no blank filler rows", () => {
    expect(src).not.toMatch(/const blanks = Math\.max\(0, 3 - officeItems\.length\)/);
  });

  test("a both-entity print adds only the retail entity, on one line", () => {
    expect(src).toMatch(/<div class="entity-line">/);
    expect(src).not.toMatch(/\{ cap: "Service Provider", p: houzsProfile \}/);
  });
});

describe("the customer's sign-off is left blank for handwriting", () => {
  const src = fs.readFileSync(path.join(REPO_BACKEND, "src/routes/assr_print.ts"), "utf8");

  test("no name is printed beside the signature line or in NAME", () => {
    expect(src).not.toMatch(/<span class="cap">Signature<\/span><span style="float: right/);
    expect(src).not.toMatch(/<span class="cap">Name<\/span>\$\{cs\.customer_name/);
  });
});
