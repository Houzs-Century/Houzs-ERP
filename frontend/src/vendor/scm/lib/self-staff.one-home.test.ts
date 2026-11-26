import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHARED_HOME = "vendor/scm/lib/self-staff.ts";

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

describe("resolving the signed-in person to a staff row", () => {
  it("matches a staff row by email or name in exactly one place", () => {
    const ladders = productionSources()
      .filter((path) => {
        const source = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        return /staffList\.find\([\s\S]{0,200}?\.(?:email|name)\b[\s\S]{0,120}?toLowerCase/.test(source)
          || /lower\(\w+\.(?:email|name)\)/.test(source);
      })
      .map((path) => relative(SRC, path).replaceAll("\\", "/"));

    expect(ladders).toEqual([SHARED_HOME]);
  });
});
