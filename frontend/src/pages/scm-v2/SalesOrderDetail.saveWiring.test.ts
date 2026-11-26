import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "SalesOrderDetail.tsx"), "utf8");
const between = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe("SalesOrderDetail save wiring", () => {
  test("Save is held from the click until that save settles, and the line writes are awaited", () => {
    const saveNow = between("const saveNow = () =>", "const saveEdit = async");
    expect(saveNow).toMatch(/if \(savePressRef\.current\) return;/);
    expect(saveNow).toMatch(/\.finally\(/);
    expect(between("const saveEdit = async", "const submitAmendment = async")).toMatch(/await reserveHeader/);
    expect(src).not.toMatch(/onClick=\{\(\) => \{ void saveEdit\(\); \}\}/);
    expect(src).not.toMatch(/onClick=\{\(\) => \{ void submitAmendment\(\); \}\}/);
    expect(src.match(/onClick=\{saveNow\}/g)?.length).toBe(2);
  });
});
