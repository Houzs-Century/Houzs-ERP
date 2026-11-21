/* SO edit save wiring, read from the source because the page needs the whole app to mount.
   - Save is held from the click until that save settles: savingOrder was only set after the validate dry-run, so a
     double click sent the whole save twice and the button stayed live while validate ran.
   - An existing line is not seeded with the Default leg height: the seed made an untouched sofa line dirty, so a
     header-only save rewrote its options and logged audit rows. A new line still is. */
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

  test("an existing line is not seeded with the Default leg height; a new line still is", () => {
    expect(between("itemId={it.id}", "attachOptions={attachOptionsById[it.id]")).toMatch(/seedSofaLegDefault=\{false\}/);
    expect(between("index={visibleLines.persisted + i}", "attachOptions={attachOptionsById[staged.key]")).toMatch(/seedSofaLegDefault=\{true\}/);
  });
});
