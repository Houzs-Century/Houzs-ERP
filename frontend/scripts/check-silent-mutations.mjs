#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-silent-mutations.mjs — find write mutations that fail WITHOUT TELLING
// ANYONE.
//
// WHY. The owner pressed "Deactivate" on a fabric and nothing happened. Nothing
// is exactly what the code did: every one of the nine mutations in
// vendor/scm/lib/fabric-queries.ts had an onSuccess and not one had an onError,
// so a refused PATCH (area guard wanting `edit` where the grid's GET only needs
// `view`, a 409 on an unresolved company, a 404 on the other company's row)
// produced no toast, no inline message and no console line. The row simply
// stayed as it was, which reads as "the button is broken".
//
// This is the worst shape a bug can take here: the USER cannot report it
// usefully ("it doesn't work"), and the DEVELOPER cannot see it either, because
// the server did answer — correctly — and the answer was dropped on the floor.
//
// WHAT IT FLAGS. A `useMutation({...})` whose options object contains no
// `onError`, no `throwOnError`, and no `onSettled`.
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   - a caller that awaits `mutateAsync` inside its own try/catch, or reads
//     `mutation.isError` / `mutation.error` to render an inline message. Those
//     are legitimate and show up here as false positives — silence one with
//     `// silent-mutation-ok: <reason>` inside the useMutation block.
//   - whether the message an onError DOES show is any good.
//   - anything outside frontend/src.
//
// Usage:
//   node frontend/scripts/check-silent-mutations.mjs           # report
//   node frontend/scripts/check-silent-mutations.mjs --strict  # exit 1 on any
//   node frontend/scripts/check-silent-mutations.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a worktree with no
// node_modules — which is the situation it was written in.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(frontendRoot, "src");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");

const HANDLED = /\bonError\b|\bthrowOnError\b|\bonSettled\b/;
const OPT_OUT = /silent-mutation-ok:/;

/* SELF-TEST. A scan whose pattern cannot match reports "all clean", which is
   indistinguishable from success — the exact failure that hid a dead regex in
   the company-scope checker for weeks. Assert before scanning; refuse to report
   from a broken pattern. */
{
  const ok =
    HANDLED.test("onError: fabricWriteFailed,") &&
    HANDLED.test("throwOnError: true") &&
    !HANDLED.test("onSuccess: () => qc.invalidateQueries()") &&
    OPT_OUT.test("// silent-mutation-ok: caller catches mutateAsync");
  if (!ok) {
    console.error("check-silent-mutations: internal pattern self-test FAILED - not reporting.");
    process.exit(2);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** From the `{` after useMutation(, return the balanced block's source. */
function optionsBlock(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(open, i + 1), end: i };
    }
  }
  return null;
}

const findings = [];
let checked = 0;

for (const file of walk(SRC).sort()) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(frontendRoot, file).split(path.sep).join("/");
  let at = 0;
  for (;;) {
    const hit = src.indexOf("useMutation(", at);
    if (hit === -1) break;
    at = hit + 12;
    const block = optionsBlock(src, hit);
    if (!block) continue;
    at = block.end;
    checked++;
    if (HANDLED.test(block.text) || OPT_OUT.test(block.text)) continue;
    /* Name it by the nearest enclosing export, so the report points at
       something a person can search for rather than a line number alone. */
    const before = src.slice(0, hit);
    const owner =
      [...before.matchAll(/export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/g)].pop()?.[1] ?? "(anonymous)";
    findings.push({ file: rel, line: before.split("\n").length, owner });
  }
}

/* ── SECOND PASS: is the caller catching it? ────────────────────────────────
   The raw first-pass count is NOT the bug count and must never be reported as
   one. A mutation with no onError is perfectly fine when its consumer awaits
   `mutateAsync` in a try/catch, or renders `mutation.isError` / `mutation.error`
   — 159 mutateAsync sites and 68 isError reads exist in this tree, so the
   difference is large enough to change the answer entirely.

   So for every hook-shaped finding (`export function useXxx`), scan every file
   that mentions that hook name and ask whether ANY consumer handles the failure.
   Only the ones where NO consumer does are reported as SILENT. Whatever this
   pass cannot resolve is reported as UNRESOLVED, separately and honestly —
   never folded into the silent count to make it look thorough. */
const allSrc = walk(SRC).map((f) => ({
  rel: path.relative(frontendRoot, f).split(path.sep).join("/"),
  text: fs.readFileSync(f, "utf8"),
}));

/** The balanced source of the call that starts at the `(` on/after `from`. */
function callArgs(src, from) {
  const open = src.indexOf("(", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/** Does this consumer file handle failures for `hook`? */
function consumerHandles(text, hook) {
  // The identifier it was bound to: `const x = useUpdateFabricActive()`.
  const bound = [...text.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${hook}\\s*\\(`, "g"))]
    .map((m) => m[1]);
  if (!bound.length) return false;
  return bound.some((v) => {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`${esc}\\s*\\.\\s*mutateAsync`).test(text) ||
      new RegExp(`${esc}\\s*\\.\\s*isError`).test(text) ||
      new RegExp(`${esc}\\s*\\.\\s*error`).test(text)
    ) return true;
    /* PER-CALL options: `x.mutate(vars, { onSuccess, onError })`. This was the
       checker's own false positive — it called ConsignmentNoteNew's create
       SILENT while the mutate call three hundred lines down passes an onError
       that shows the server's message. The whole point of this second pass is
       to not over-report, so it has to read the CALL, not just the hook. */
    const re = new RegExp(`${esc}\\s*\\.\\s*mutate\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      if (/\bonError\b/.test(callArgs(text, m.index + m[0].length - 1))) return true;
    }
    return false;
  });
}

/* INLINE MUTATIONS — declared inside a component rather than in a `useXxx`
   hook. The consumer scan below cannot resolve them by name, and they were all
   reported UNRESOLVED: 53 of them, which is a pile a human is told to read and
   never does.

   But an inline mutation's consumer IS the file it sits in. So apply exactly
   the same test to THIS file: was the result bound to a variable that is then
   awaited via mutateAsync, read as .isError / .error, or given per-call options
   on .mutate(vars, { onError })? That resolves most of them mechanically and
   leaves only the genuinely ambiguous for a person. */
const byFile = new Map();
for (const s of allSrc) byFile.set(s.rel, s.text);

for (const f of findings) {
  if (!/^use[A-Z]/.test(f.owner)) {
    const text = byFile.get(f.file) ?? "";
    /* The binding is on the line the mutation is assigned to — find the nearest
       `const <name> = useMutation(` at or before this finding's offset. */
    const upto = text.split("\n").slice(0, f.line).join("\n");
    const bound = [...upto.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*useMutation\s*\(/g)].pop()?.[1];
    if (!bound) { f.verdict = "UNRESOLVED"; continue; }
    const esc = bound.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handled =
      new RegExp(`${esc}\\s*\\.\\s*mutateAsync`).test(text) ||
      new RegExp(`${esc}\\s*\\.\\s*isError`).test(text) ||
      new RegExp(`${esc}\\s*\\.\\s*error`).test(text) ||
      [...text.matchAll(new RegExp(`${esc}\\s*\\.\\s*mutate\\s*\\(`, "g"))]
        .some((m) => /\bonError\b/.test(callArgs(text, m.index + m[0].length - 1)));
    f.verdict = handled ? "CAUGHT" : "SILENT";
    continue;
  }
  const consumers = allSrc.filter((s) => s.rel !== f.file && s.text.includes(f.owner));
  if (!consumers.length) { f.verdict = "UNRESOLVED"; continue; }
  f.verdict = consumers.some((s) => consumerHandles(s.text, f.owner)) ? "CAUGHT" : "SILENT";
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const silent = findings.filter((f) => f.verdict === "SILENT");
const unresolved = findings.filter((f) => f.verdict === "UNRESOLVED");

if (jsonOut) {
  console.log(JSON.stringify({ checked, silent, unresolved, findings }, null, 2));
} else {
  console.log(
    `Checked ${checked} useMutation call sites.\n` +
      `${findings.length} declare no onError / throwOnError / onSettled.\n` +
      `  ${silent.length} SILENT     - and no consumer catches it either. A server refusal reaches nobody.\n` +
      `  ${findings.length - silent.length - unresolved.length} CAUGHT     - a consumer awaits mutateAsync or renders .isError / .error.\n` +
      `  ${unresolved.length} UNRESOLVED - inline in a component, or no consumer found. Read these by hand.\n` +
      `Silence a verified-safe one with "// silent-mutation-ok: <reason>" inside the block.\n`,
  );
  for (const [label, list] of [["SILENT", silent], ["UNRESOLVED", unresolved]]) {
    if (!list.length) continue;
    console.log(`\n=== ${label} ===`);
    let last = "";
    for (const f of list) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.owner}`);
    }
  }
}

// --strict gates on the SILENT set only. Gating on the raw count would fail on
// mutations that are correctly handled by their caller, and a gate that cries
// wolf is a gate someone turns off.
process.exit(strict && silent.length ? 1 : 0);
