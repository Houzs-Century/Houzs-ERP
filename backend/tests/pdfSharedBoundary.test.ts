// The Worker bundles part of the frontend: the document layout code behind the
// AI Connector's get_pdf (src/lib/shared-pdf.ts). Two things must hold, and
// nothing else would notice them breaking:
//   1. every frontend file that import graph reaches sits under
//      PDF_SHARED_FRONTEND_PATHS — so the list is the truth;
//   2. ci.yml and deploy.yml treat exactly those paths as backend too — or a
//      frontend-only edit to the SO layout would change the Worker's PDFs
//      without testing or redeploying the Worker.
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

const files = [...graph(resolve(here, "../src/lib/shared-pdf.ts"))].map(rel);
const frontend = files.filter((f) => f.startsWith("frontend/"));
const covered = (f: string) => PDF_SHARED_FRONTEND_PATHS.some((p: string) => (p.endsWith("/") ? f.startsWith(p) : f === p));

describe("the frontend code the Worker bundles for get_pdf", () => {
  it("reaches the layout code it is meant to", () => {
    expect(frontend).toContain("frontend/src/vendor/scm/lib/sales-order-pdf-render.ts");
    expect(frontend).toContain("frontend/src/vendor/scm/lib/purchase-order-pdf-render.ts");
    expect(frontend).toContain("frontend/src/vendor/scm/lib/pdf-core.ts");
  });

  it("stays inside the declared paths and never reaches a browser-only module", () => {
    expect(frontend.filter((f) => !covered(f))).toEqual([]);
    const browserOnly = /pdf-common\.ts$|pdf-item-photos-canvas\.ts$|authed-fetch\.ts$|-queries\.ts$|\/api\/|lib\/branding\.ts$|hooks\//;
    expect(frontend.filter((f) => browserOnly.test(f))).toEqual([]);
  });

  it("is treated as backend by CI and by the deploy", () => {
    const ci = readFileSync(resolve(repo, ".github/workflows/ci.yml"), "utf8");
    const deploy = readFileSync(resolve(repo, ".github/workflows/deploy.yml"), "utf8");
    for (const p of PDF_SHARED_FRONTEND_PATHS as string[]) {
      expect(ci, `ci.yml changes: ${p}`).toContain(p.endsWith("/") ? `${p}*` : p);
      expect(deploy, `deploy.yml backend filter: ${p}`).toContain(p.endsWith("/") ? `'${p}**'` : `'${p}'`);
    }
  });
});
