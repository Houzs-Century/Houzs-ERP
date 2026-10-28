#!/usr/bin/env node
// Keeps the working rules, guides and lists from growing back into essays (owner, 2026-09-15).
// On a merge conflict in one of these files, take main's version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limits = [
  ["CLAUDE.md", 150],
  ["docs/bugs/README.md", 400],
  ["tasks/TODO.md", 200],
];
const modulesDir = path.join(root, "docs", "modules");
for (const name of fs.readdirSync(modulesDir)) {
  if (name.endsWith(".md")) limits.push([`docs/modules/${name}`, 400]);
}

const over = [];
for (const [rel, max] of limits) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n").length;
  if (lines > max) over.push(`  ${rel}: ${lines} lines (limit ${max})`);
}

if (over.length) {
  console.error("These files grew past their limit. Keep only current rules; on a merge conflict take main's version.");
  console.error(over.join("\n"));
  process.exit(1);
}
console.log(`docs size OK (${limits.length} files)`);
