
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripComments } from "../../../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const feSrc = (rel: string) =>
  stripComments(readFileSync(resolve(HERE, "..", "..", "..", rel), "utf8"));

const BRIDGE_CONSUMERS = [
  "pages/scm-v2/ConsignmentOrderNew.tsx",
  "pages/scm-v2/SalesOrderNew.tsx",
  "pages/scm-v2/SalesOrderDetail.tsx",
] as const;

describe("the bridge names nobody", () => {
  const src = feSrc("vendor/scm/lib/auth.ts");

  test.each(["id", "name", "staffCode", "venueId"])(
    "staff.%s is a hard-coded null in the returned object",
    (field) => {
      const returned = src.match(/return \{ staff: \{([^}]*)\}/)?.[1] ?? "";
      expect(returned).toMatch(new RegExp(`${field}:\\s*null`));
    },
  );

  test("role is the ONLY field it actually computes", () => {
    const returned = src.match(/return \{ staff: \{([^}]*)\}/)?.[1] ?? "";
    const computed = returned
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !/:\s*null$/.test(p));
    expect(computed).toEqual(["role"]);
  });
});

describe("no page renders a person out of the bridge", () => {
  test("BRIDGE_CONSUMERS is every page that takes staff off the bridge", () => {
    const roots = ["pages/scm-v2", "mobile", "pages", "components", "vendor/scm/components"];
    const seen = new Set<string>();
    const walk = (relDir: string) => {
      let entries: string[];
      try { entries = readdirSync(resolve(HERE, "..", "..", "..", relDir)); } catch { return; }
      for (const e of entries) {
        const rel = `${relDir}/${e}`;
        const abs = resolve(HERE, "..", "..", "..", rel);
        if (statSync(abs).isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(e) || /\.test\./.test(e)) continue;
        if (/staff: currentStaff\s*\}\s*=\s*useAuth\(\)/.test(readFileSync(abs, "utf8"))) seen.add(rel);
      }
    };
    for (const r of roots) walk(r);
    expect([...seen].sort()).toEqual([...BRIDGE_CONSUMERS].sort());
  });

  test.each(BRIDGE_CONSUMERS)("%s does not label anything from currentStaff", (rel) => {
    const hit = feSrc(rel).match(/\$\{currentStaff[.?]/)?.[0] ?? null;
    expect(hit).toBeNull();
  });

  test.each(BRIDGE_CONSUMERS)("%s does not gate a seed on currentStaff?.id", (rel) => {
    const hit = feSrc(rel).match(/if\s*\(\s*!currentStaff\?\.id\s*\)/)?.[0] ?? null;
    expect(hit).toBeNull();
  });

  test.each(BRIDGE_CONSUMERS)("%s resolves its person through resolveSelfStaff", (rel) => {
    expect(feSrc(rel)).toContain("resolveSelfStaff(");
  });
});
