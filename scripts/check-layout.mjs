#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["frontend", "backend"];

export function layoutViolations(paths, allow) {
  const baseline = new Set(allow._baseline ?? []);
  const out = new Set();
  for (const p of paths) {
    if (baseline.has(p)) continue;
    const parts = p.split("/");
    if (!allow.root.includes(parts[0])) out.add(`repo root: ${parts[0]}`);
    const scope = parts.slice(0, 2).join("/");
    if (allow[scope] && parts.length > 3 && !allow[scope].includes(parts[2])) out.add(`${scope}: ${parts[2]}/`);
  }
  return [...out].sort();
}

const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|test|tests)\//.test(p.split("/src/")[1] ?? "");

export function crossImports(file, source) {
  const app = file.split("/")[0];
  if (!APPS.includes(app) || isTest(file)) return [];
  const hits = [];
  for (const m of source.matchAll(/(?:from|import\(|require\()\s*["'](\.\.?\/[^"']+)["']/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    const other = target.split("/")[0];
    if (other !== app && APPS.includes(other)) hits.push(`${file} imports ${m[1]}`);
  }
  return hits;
}

function main() {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  const allow = JSON.parse(fs.readFileSync(path.join(root, "scripts/layout-allowlist.json"), "utf8"));
  const layout = layoutViolations(paths, allow);
  const imports = paths
    .filter((p) => /^(frontend|backend)\/src\/.*\.[cm]?[jt]sx?$/.test(p) && fs.existsSync(path.join(root, p)))
    .flatMap((p) => crossImports(p, fs.readFileSync(path.join(root, p), "utf8")));
  if (layout.length) {
    console.error("New top-level entries that are not on scripts/layout-allowlist.json:");
    console.error(layout.map((s) => `  ${s}`).join("\n"));
    console.error("Put the code in an existing folder, or add the folder to scripts/layout-allowlist.json and to docs/CODEBASE-MAP.md in the same PR.");
  }
  if (imports.length) {
    console.error("frontend/src and backend/src must not import each other (move shared code to a shared module):");
    console.error(imports.map((s) => `  ${s}`).join("\n"));
  }
  if (layout.length || imports.length) process.exit(1);
  console.log(`layout OK (${paths.length} tracked paths)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
