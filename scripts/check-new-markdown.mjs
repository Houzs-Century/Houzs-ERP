#!/usr/bin/env node
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WAIVER_LABEL = "docs-requested";
export const UNSOLICITED =
  "An unsolicited markdown is a plan, handoff, findings, report, summary or notes file nobody asked for; put the content in the PR body or tasks/TODO.md (one line).";

export function allowedMarkdown(p) {
  if (!p.toLowerCase().endsWith(".md")) return true;
  return (
    /^docs\/modules\/[^/]+\.md$/.test(p) ||
    p === "docs/bugs/README.md" ||
    p === "tasks/TODO.md" ||
    (path.posix.basename(p) === "README.md" && !p.startsWith("docs/")) ||
    /^\.claude\/skills\/.+\/SKILL\.md$/.test(p) ||
    /^\.claude\/skills\/.+\/references\//.test(p) ||
    /^\.github\/(pull_request_template\.md|PULL_REQUEST_TEMPLATE\/[^/]+\.md|ISSUE_TEMPLATE\/[^/]+\.md)$/.test(p)
  );
}

export function classify(paths, labels) {
  const blocked = paths.filter((p) => !allowedMarkdown(p));
  const waived = blocked.length > 0 && labels.some((l) => l.toLowerCase() === WAIVER_LABEL);
  return { ok: blocked.length === 0 || waived, blocked, waived };
}

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);

function addedFiles() {
  if (process.env.BASE_SHA) return git(["diff", "--name-only", "--no-renames", "--diff-filter=A", `${process.env.BASE_SHA}...${process.env.HEAD_SHA || "HEAD"}`]);
  const base = git(["merge-base", "origin/main", "HEAD"])[0];
  return [...git(["diff", "--name-only", "--no-renames", "--diff-filter=A", base]), ...git(["ls-files", "--others", "--exclude-standard"])];
}

function main() {
  const labels = (process.env.PR_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let files;
  try {
    files = addedFiles();
  } catch (err) {
    console.error(`Could not list the files this PR adds (run git fetch origin main): ${err.message}`);
    process.exit(2);
  }
  const v = classify(files, labels);
  if (v.waived) console.log(`The ${WAIVER_LABEL} label waived: ${v.blocked.join(", ")}`);
  if (v.ok) {
    console.log(`new markdown OK (${files.length} added file(s))`);
    return;
  }
  console.error("This PR adds markdown files outside the allowed places:");
  console.error(v.blocked.map((f) => `  ${f}`).join("\n"));
  console.error(UNSOLICITED);
  console.error(`Allowed: docs/modules/*.md, docs/bugs/README.md, tasks/TODO.md, a README.md outside docs/, .claude/skills/**/SKILL.md or references/, .github PR and issue templates. If the owner asked for this file, add the \`${WAIVER_LABEL}\` label.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
