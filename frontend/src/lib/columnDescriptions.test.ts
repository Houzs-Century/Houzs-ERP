import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { columnDescription } from "./columnDescriptions";

/* A description for a column that no longer exists is a silent lie in waiting:
   every table id listed must be on a page, and every key must be a column key
   that page still declares. */

const SRC = join(__dirname, "..");
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}
const sources = [...files(join(SRC, "pages"))].map((p) => readFileSync(p, "utf8"));
const table = readFileSync(join(__dirname, "columnDescriptions.ts"), "utf8");
const blocks = [...table.matchAll(/"([a-z0-9-]+)": \{([^}]*)\}/g)].map((m) => ({
  id: m[1]!,
  keys: [...m[2]!.matchAll(/^\s*([A-Za-z_0-9]+):/gm)].map((k) => k[1]!),
}));

describe("column descriptions", () => {
  it("lists tables", () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  it.each(blocks)("$id: every described column still exists on its page", ({ id, keys }) => {
    const page = sources.find((s) => s.includes(`tableId="${id}"`));
    expect(page, `no page renders tableId="${id}"`).toBeDefined();
    for (const k of keys) {
      expect(new RegExp(`key:\\s*["']${k}["']|${k}:\\s*\\{|\\(["']${k}["'],`).test(page!), `${id}.${k}`).toBe(true);
      expect(columnDescription(id, k)).toBeTruthy();
    }
  });
});
