#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function lintApps(changed, hasLint) {
  return [...new Set(changed.map((f) => f.split("/")[0]))].filter(hasLint).sort();
}

export function buildSteps({ fast, apps }) {
  const node = (name, script) => ({ name, cmd: process.execPath, args: [`scripts/${script}`] });
  const steps = [
    node("layout", "check-layout.mjs"),
    node("new markdown", "check-new-markdown.mjs"),
    node("docs size", "check-docs-size.mjs"),
    node("file size", "check-file-size.mjs"),
  ];
  if (!fast) for (const app of apps) steps.push({ name: `lint ${app}`, cmd: "npm", args: ["--prefix", app, "run", "lint"], shell: true });
  return steps;
}

function changedFiles() {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  const base = git(["merge-base", "origin/main", "HEAD"])[0];
  return [...git(["diff", "--name-only", base]), ...git(["ls-files", "--others", "--exclude-standard"])];
}

function hasLint(app) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(root, app, "package.json"), "utf8")).scripts?.lint);
  } catch {
    return false;
  }
}

function main() {
  const fast = process.argv.includes("--fast");
  const steps = buildSteps({ fast, apps: fast ? [] : lintApps(changedFiles(), hasLint) });
  const results = steps.map((s) => {
    console.log(`\n== ${s.name}`);
    const r = spawnSync(s.cmd, s.args, { cwd: root, stdio: "inherit", shell: s.shell ?? false });
    return [s.name, r.status === 0];
  });
  console.log("\nagent-check:");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
