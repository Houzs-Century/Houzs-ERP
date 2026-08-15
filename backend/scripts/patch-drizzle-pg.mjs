/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for the D1 -> Supabase cutover and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   A SOURCE codemod, same cutover. It drives off a file list that has since been renamed, split and deleted.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
// One-shot codemod for the D1->Supabase cutover. Drives off the TypeScript
// compiler's own error locations so it only edits the exact lines where
// postgres-js Drizzle differs from the old D1/SQLite Drizzle:
//
//   .get()                -> .then((r) => r[0])     (query-builder single row)
//   db.all<T>(sql`...`)   -> db.execute<T>(sql`...`) (raw SQL, returns rows)
//   result.meta?.changes  -> result.count           (update/delete affected n)
//
// Re-runnable: it re-reads tsc each pass and only patches still-flagged lines.
// EOL-preserving (keeps CRLF) so git doesn't see whole-file churn.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

let out = "";
try {
  out = execSync("npx tsc --noEmit -p .", { encoding: "utf8" });
} catch (e) {
  out = (e.stdout || "") + (e.stderr || "");
}

const re =
  /^(src[/\\][\w/\\.-]+\.ts)\((\d+),\d+\): error TS2339: Property '(get|all|meta)' does not exist/;
const byFile = new Map();
for (const ln of out.split(/\r?\n/)) {
  const m = ln.match(re);
  if (!m) continue;
  const file = m[1].replace(/\\/g, "/");
  const lineNo = Number(m[2]);
  if (!byFile.has(file)) byFile.set(file, new Map());
  const lines = byFile.get(file);
  if (!lines.has(lineNo)) lines.set(lineNo, new Set());
  lines.get(lineNo).add(m[3]);
}

let patched = 0;
const skipped = [];
for (const [file, lines] of byFile) {
  // Split on \n only so any trailing \r stays attached to each line (CRLF safe).
  const src = readFileSync(file, "utf8").split("\n");
  for (const [lineNo, props] of lines) {
    const i = lineNo - 1;
    const before = src[i];
    let line = before;
    if (props.has("get")) line = line.replace(".get()", ".then((r) => r[0])");
    if (props.has("all")) line = line.replace(/\.all\s*</, ".execute<");
    if (props.has("meta"))
      line = line
        .replace(/\.meta\?\.changes/g, ".count")
        .replace(/\.meta\.changes/g, ".count");
    if (line !== before) {
      src[i] = line;
      patched++;
    } else {
      skipped.push(`${file}:${lineNo} [${[...props]}] -> ${before.trim()}`);
    }
  }
  writeFileSync(file, src.join("\n"));
}

console.log(`patched ${patched} line(s) across ${byFile.size} file(s)`);
if (skipped.length) {
  console.log(`\nNOT patched (token not found on flagged line) — handle by hand:`);
  for (const s of skipped) console.log("  " + s);
}
