#!/usr/bin/env node
/**
 * Scaffold a bug-ledger entry: `docs/bugs/NNNN-slug.md`.
 *
 *   node scripts/new-bug.mjs "The confirm gate accepted a cancelled PO"
 *   node scripts/new-bug.mjs "..." --severity critical --area "Sales orders + pricing"
 *
 * WHY A SCAFFOLD EXISTS. CLAUDE.md makes the entry MANDATORY on every code PR,
 * so this is written several times a day, by agents as often as by people. The
 * two things that are easy to get wrong by hand — the four-digit ordinal and the
 * filename shape — are the two that make an entry invisible to the ledger, the
 * index and the working-agreement gate simultaneously. Computing them is one
 * command; remembering them is a rule.
 *
 * TWO BRANCHES CAN PICK THE SAME ORDINAL, and that is fine. They write different
 * FILES (the slug differs), so there is no conflict — which is the entire point
 * of the change that made the ledger a directory. The ordinal orders the
 * combined view and nothing else, and ties fall to the filename, so the render
 * stays deterministic either way. Do NOT add a lock, a registry or a manifest to
 * make ordinals unique: a shared file that every entry must update is exactly
 * the thing this replaced.
 *
 * NO DEPENDENCIES — it must run in a fresh worktree with no node_modules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUG_DIR, nextOrdinal, readEntries, slugify } from "../backend/scripts/lib/bug-ledger.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    i++;
  } else {
    positional.push(argv[i]);
  }
}
const flag = (name) => (flags.has(name) ? flags.get(name) : null);
const title = positional.join(" ").trim();

if (!title) {
  console.error('usage: node scripts/new-bug.mjs "<title>" [--severity high] [--area "<area>"]');
  console.error("");
  console.error("Severity is one of critical / high / medium / low. The area, when given, must be one");
  console.error("of the names in backend/scripts/gen-bug-index.mjs — an unknown one FAILS that generator.");
  process.exit(2);
}

const severity = flag("severity") ?? "medium";
const area = flag("area");

const { entries } = readEntries(REPO);
if (entries.length === 0) {
  console.error(`${BUG_DIR} parsed ZERO entries — refusing to number a new one against nothing.`);
  process.exit(2);
}

const ordinal = nextOrdinal(entries);
const name = `${String(ordinal).padStart(4, "0")}-${slugify(title)}.md`;
const rel = `${BUG_DIR}/${name}`;
const full = path.join(REPO, rel);

if (fs.existsSync(full)) {
  console.error(`${rel} already exists. Pick a different title, or edit that entry.`);
  process.exit(1);
}

const body = [
  `## ${title} [${severity}]`,
  "",
  ...(area ? [`<!-- area: ${area} -->`, ""] : []),
  "**Symptom.** What was seen, in the words of whoever saw it.",
  "",
  "**Root cause (traced).** The line it actually goes wrong on, and how that was",
  "observed — not the first plausible story.",
  "",
  "**Fix.** What changed, and the test that pins it. Say it was proved RED on the",
  "unfixed tree.",
  "",
  `**Ref.** ${process.env.BRANCH ?? "<branch>"}, ${new Date().toISOString().slice(0, 10)}.`,
  "",
].join("\n");

fs.writeFileSync(full, body, "utf8");
console.log(rel);
