// Read-only: numbers that ALREADY have a "+" but whose country code is wrong.
//
// The backfill only touches numbers WITHOUT a "+". It cannot see a number that
// a past migration already prefixed wrongly — e.g. a Chinese supplier stored as
// "+6013262989777" (a +60 wrapper around the Chinese mobile 13262989777). That
// number is unreachable, and it looks correct, so nobody questions it. This
// finds them so a human can decide.
//
// Heuristic (reported, never changed): a "+60" number whose digits after 60 do
// NOT look like a valid Malaysian number — i.e. the national part does not start
// with 1 (mobile) or 3-9 (landline), OR is the wrong length. The clearest case
// is "+60" followed by another country's mobile: +60 13…, +60 15…, +60 18…
// (11-digit Chinese-shaped), which cannot be Malaysian (MY mobile is 01X → +60 1X,
// 9-10 national digits; +6013xxxxxxxxx is 11 national digits).
import { readFileSync } from "node:fs";
import postgres from "postgres";
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// (table, column) — same set the backfill covers.
const COLS = [
  ["creditors","phone1"],["creditors","mobile"],["creditors","phone2"],
  ["users","phone"],["sales_orders","phone"],["assr_cases","phone"],
  ["sales_entries","customer_phone"],
];
try {
  let total = 0;
  for (const [t,c] of COLS) {
    // +60 followed by 11 national digits (Malaysian national is 9-10), or the
    // national part starting with 0 or 2 (no such Malaysian prefix).
    const rows = await pg`
      SELECT ${pg(c)} AS v, count(*)::int AS n
      FROM ${pg(t)}
      WHERE regexp_replace(coalesce(${pg(c)},''),'\D','','g') ~ '^60'
        AND ( length(regexp_replace(coalesce(${pg(c)},''),'\D','','g')) NOT BETWEEN 11 AND 12
              OR substring(regexp_replace(coalesce(${pg(c)},''),'\D','','g') from 3 for 1) IN ('0','2') )
      GROUP BY ${pg(c)} ORDER BY n DESC LIMIT 20`;
    if (rows.length) {
      notice(`── ${t}.${c}: ${rows.length} suspicious`);
      for (const r of rows) { notice(`     ${JSON.stringify(r.v)}  (x${r.n})`); total += r.n; }
    }
  }
  notice(total === 0 ? "None found — no obviously-wrong +60 prefixes." : `TOTAL ~${total} numbers with a +60 that cannot be Malaysian. A human must reclassify.`);
} finally { await pg.end({ timeout: 5 }); }
