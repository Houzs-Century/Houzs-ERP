/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for the D1 -> Supabase cutover and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   A SOURCE codemod. It rewrote SQLite dialect into Postgres across the tree; the tree it was written against no longer exists.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
// Source-level dialect fixes for the D1->Supabase cutover that the shim cannot
// reach: Drizzle sql`` fragments (compiled by Drizzle, bypassing env.DB), plus
// GROUP_CONCAT and INSERT OR IGNORE which need a Postgres rewrite.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const NOW_TS = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";
const exact = [
  // Drizzle sql`` timestamp fragments (bypass the shim).
  ["sql`datetime('now')`", "sql`" + NOW_TS + "`"],
  [
    "sql`date('now', '-30 days')`",
    "sql`to_char(timezone('UTC', now()) - interval '30 days', 'YYYY-MM-DD')`",
  ],
  // GROUP_CONCAT -> string_agg (SQLite blob sep X'1f' -> chr(31)).
  ["GROUP_CONCAT(et.name, ', ')", "string_agg(et.name, ', ')"],
  ["GROUP_CONCAT(brand, ',')", "string_agg(brand, ',')"],
  ["GROUP_CONCAT(ub.brand, X'1f')", "string_agg(ub.brand, chr(31))"],
];

let changed = 0;
for (const f of walk("src")) {
  let s = readFileSync(f, "utf8");
  const before = s;
  for (const [a, b] of exact) s = s.split(a).join(b);
  // INSERT OR IGNORE -> append ON CONFLICT DO NOTHING (single VALUES tuple).
  s = s.replace(
    /INSERT OR IGNORE INTO ([\s\S]*?VALUES\s*\([^)]*\))/g,
    "INSERT INTO $1 ON CONFLICT DO NOTHING",
  );
  if (s !== before) {
    writeFileSync(f, s);
    changed++;
    console.log("patched", f);
  }
}
console.log("files changed:", changed);
