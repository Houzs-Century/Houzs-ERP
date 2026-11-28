#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classify, UNSOLICITED } from "../../scripts/check-new-markdown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const file = input.tool_input?.file_path;
if (input.tool_name !== "Write" || typeof file !== "string" || !file.toLowerCase().endsWith(".md")) process.exit(0);
const abs = path.resolve(root, file);
const rel = path.relative(root, abs).split(path.sep).join("/").replace(/^\.claude\/worktrees\/[^/]+\//, "");
if (rel.startsWith("..") || path.isAbsolute(rel) || fs.existsSync(abs)) process.exit(0);
if (classify([rel], []).ok) process.exit(0);
let dir = path.dirname(abs);
while (!fs.existsSync(dir)) dir = path.dirname(dir);
if (spawnSync("git", ["check-ignore", "-q", abs], { cwd: dir }).status === 0) process.exit(0);
console.error(`Blocked: ${rel} is a new markdown file outside the allowed places. ${UNSOLICITED} Write notes to your scratchpad instead, or ask the owner.`);
process.exit(2);
