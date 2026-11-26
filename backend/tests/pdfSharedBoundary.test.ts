// The Worker bundles the SO / PO document layout behind the AI Connector's
// get_pdf (src/lib/shared-pdf.ts) from the root shared/ module, which the
// frontend bundles too. What must hold, and nothing else would notice breaking:
//   1. that import graph stays inside shared/ and never reaches frontend/ — the
//      layout rule (scripts/check-layout.mjs) only sees relative imports written
//      in backend/src, not where shared/ files lead;
//   2. ci.yml and deploy.yml treat shared/ as both halves, or a shared-only edit
//      would change the Worker's PDFs without testing or redeploying it;
//   3. each backend test runner resolves the kit's bare names.
// (That the graph stays DOM-free is held by the backend typecheck, which has no
// DOM lib.)
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_SHARED_ALIASES, PDF_SHARED_FRONTEND_PATHS } from "../scripts/lib/pdf-shared-aliases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const rel = (p: string) => relative(repo, p).split("\\").join("/");

function resolveSpec(from: string, spec: string): string | null {
  const alias = PDF_SHARED_ALIASES.find((a) => a.find.test(spec));
  let base: string;
  if (alias) base = alias.replacement;
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package (jspdf, …)
  for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) if (existsSync(cand) && cand.endsWith(".ts")) return cand;
  return null;
}

/** Every local file reachable from `entry`, following type-only imports too (tsc does). */
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const next = resolveSpec(file, m[1]);
      if (next) todo.push(next);
    }
  }
  return seen;
}

const files = [...graph(resolve(here, "../src/lib/shared-pdf.ts"))].map(rel).filter((f) => !f.startsWith("backend/"));
const covered = (f: string) => PDF_SHARED_FRONTEND_PATHS.some((p: string) => (p.endsWith("/") ? f.startsWith(p) : f === p));

describe("the shared code the Worker bundles for get_pdf", () => {
  it("reaches the layout code it is meant to", () => {
    expect(files).toContain("shared/src/vendor/scm/lib/sales-order-pdf-render.ts");
    expect(files).toContain("shared/src/vendor/scm/lib/purchase-order-pdf-render.ts");
    expect(files).toContain("shared/src/vendor/scm/lib/pdf-core.ts");
  });

  it("stays inside shared/ and never reaches into frontend/", () => {
    expect(files.filter((f) => !covered(f))).toEqual([]);
    expect(files.filter((f) => f.startsWith("frontend/"))).toEqual([]);
  });

  it("resolves in each backend test runner (vitest reads neither tsconfig paths nor wrangler [alias])", () => {
    for (const cfg of ["vitest.config.mts", "vitest.light.config.mts", "vitest.pg.config.ts"]) {
      expect(readFileSync(resolve(here, "..", cfg), "utf8"), cfg).toContain("PDF_SHARED_ALIASES");
    }
    for (const a of PDF_SHARED_ALIASES) expect(existsSync(a.replacement), a.replacement).toBe(true);
  });

  it("is tested and deployed as both halves", () => {
    const ci = readFileSync(resolve(repo, ".github/workflows/ci.yml"), "utf8");
    const deploy = readFileSync(resolve(repo, ".github/workflows/deploy.yml"), "utf8");
    expect(ci).toContain("shared/*) backend=true; frontend=true ;;");
    const filters = deploy.slice(deploy.indexOf("filters: |"));
    const backend = filters.slice(filters.indexOf("backend:"), filters.indexOf("frontend:"));
    const frontend = filters.slice(filters.indexOf("frontend:"), filters.indexOf("\n\n"));
    expect(backend).toContain("'shared/**'");
    expect(frontend).toContain("'shared/**'");
  });
});
