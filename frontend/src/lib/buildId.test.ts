import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_ID_META, readBuildId } from "./buildId";

describe("build id comes from index.html, not from the code chunks", () => {
  it("reads the meta tag the build writes into index.html", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const meta = doc.createElement("meta");
    meta.name = BUILD_ID_META;
    meta.content = "mu0mr0cg";
    doc.head.appendChild(meta);
    expect(readBuildId(doc)).toBe("mu0mr0cg");
  });

  it("is 'dev' with no tag, an empty tag, or no document", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(readBuildId(doc)).toBe("dev");
    const meta = doc.createElement("meta");
    meta.name = BUILD_ID_META;
    meta.content = "  ";
    doc.head.appendChild(meta);
    expect(readBuildId(doc)).toBe("dev");
    expect(readBuildId(undefined)).toBe("dev");
  });

  /* WHY THIS IS PINNED. A per-build value compiled INTO a chunk changes that
     chunk's hash on every build, and every chunk importing it inherits the new
     name — measured 2026-09-14: building one unchanged commit twice renamed 391
     of 561 files in dist/assets3, sales-order-pdf among them. Each deploy then
     deleted the file an open tab was about to import. A `define` of it anywhere
     in src brings that back silently, so the source may not mention it. */
  it("no source file compiles a per-build define into the bundle", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(path, "utf8").includes("__BUILD_ID__")) offenders.push(path);
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(__dirname, "..", "..", "vite.config.ts"), "utf8")).not.toMatch(/__BUILD_ID__\s*:/);
  });
});
