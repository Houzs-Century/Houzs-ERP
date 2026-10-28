import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Owner 2026-09-25: "整个系统的ref number表头都一致换成 Ref No." The Sales
// Order's reference (ref / customer_so_no, see customer-ref.ts) was captioned
// seven ways across the modules: "Ref.", "Reference", "Customer ref",
// "Customer SO ref", "Customer Ref", "Ref No", "Ref". Every screen now says
// "Ref No.". This scans the whole tree so a new page cannot bring an old
// caption back. It checks string literals and JSX text only, not comments.
//
// Not covered, on purpose: export-file headers that keep AutoCount's own
// caption (the SO list's "Ref." rides `exportLabel`), and "Reference" where it
// means something else (bank / merchant reconciliation, credit notes, a
// payment's approval reference).

const SRC = join(process.cwd(), "src");
const OLD_CAPTIONS = ["Customer SO ref", "Customer SO Ref", "Customer ref", "Customer Ref", "Ref No"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Quoted literals and JSX text that are exactly one of the old captions. */
function offenders(source: string): string[] {
  const hits: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const cap of OLD_CAPTIONS) {
    const esc = cap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(["'\`]${esc}["'\`])|(>\\s*${esc}\\s*<)`, "g");
    for (const m of code.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

describe("the SO reference is captioned Ref No. everywhere", () => {
  it("no screen uses an old caption", () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      for (const hit of offenders(readFileSync(file, "utf8"))) found.push(`${relative(SRC, file)}: ${hit}`);
    }
    expect(found).toEqual([]);
  });

  it("the scan catches each old form", () => {
    expect(offenders(`label: "Customer ref",`)).toEqual([`"Customer ref"`]);
    expect(offenders(`<span>Customer SO Ref</span>`)).toEqual([">Customer SO Ref<"]);
    expect(offenders(`label="Ref No"`)).toEqual([`"Ref No"`]);
    expect(offenders(`label="Ref No."`)).toEqual([]);
    expect(offenders(`// was "Customer ref"`)).toEqual([]);
  });
});
