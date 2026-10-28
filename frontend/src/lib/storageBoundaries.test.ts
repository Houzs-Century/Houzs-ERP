import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return productionSources()
    .filter((path) => {
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      return pattern.test(source);
    })
    .map((path) => relative(SRC, path).replaceAll("\\", "/"));
}

describe("browser storage boundaries", () => {
  it("keeps every bearer token read behind authToken", () => {
    expect(filesMatching(/(?:localStorage|sessionStorage)\.getItem\(["']auth:token["']/))
      .toEqual([]);
  });

  it("keeps every active-company read behind activeCompany", () => {
    expect(filesMatching(/localStorage\.getItem\(["']houzs\.activeCompanyId["']/))
      .toEqual([]);
  });

  it("prevents production code from consuming legacy unscoped SCM handoffs", () => {
    const directReads = filesMatching(/sessionStorage\.getItem\(["'](?:cnFromOrderPicks|crFromNotePicks|doFromSoPicks|drFromDoPicks|grnFromPoPicks|grnNewDraft|pcrFromOrderPicks|pcrnFromReceivePicks|piFromGrnPicks|poFromSoPicks|poNewDraft|siFromDoPicks|soScanPrefill)["']/);
    expect(directReads).toEqual([]);
  });
});
