// Read-only: how many bank statement lines each company holds, and so whether
// the bank statements list's "still to decide" figures were ever cut short.
//
// Until fix/bank-statement-open-count, GET /accounting/bank/statements read
// every acc_bank_statement_lines row of the company in ONE unpaged PostgREST
// read. PostgREST answers at most db-max-rows (1,000 assumed,
// src/scm/lib/paginate-all.ts) without an error, so a company past 1,000 lines
// saw too few open lines and too small an open amount per statement.
//
// COUNTS ONLY. Actions logs are public, so no amount, description, reference
// or name is printed — company ids and row counts, nothing else.
//
// Strictly one SELECT, no transaction. Exits 0 for every real answer; only an
// unreachable database or a query error exits non-zero.
//
// RE-RUN: safe at any time, as often as wanted; it changes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const CAP = 1000;

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT company_id,
           count(*)::int                                  AS lines,
           (count(*) FILTER (WHERE state = 'OPEN'))::int   AS open_lines,
           count(DISTINCT statement_id)::int               AS statements
      FROM scm.acc_bank_statement_lines
     GROUP BY company_id
     ORDER BY company_id`;

  if (rows.length === 0) {
    notice("No bank statement lines in any company. The cap never applied.");
  } else {
    console.log("company_id | lines | open_lines | statements | past the 1,000 cap");
    for (const r of rows) {
      console.log(`${r.company_id} | ${r.lines} | ${r.open_lines} | ${r.statements} | ${r.lines > CAP ? "YES" : "no"}`);
    }
    const hit = rows.filter((r) => r.lines > CAP);
    notice(
      hit.length === 0
        ? `No company holds more than ${CAP} statement lines: the list's open figures were never cut short.`
        : `${hit.length} of ${rows.length} companies hold more than ${CAP} statement lines (company ${hit.map((r) => r.company_id).join(", ")}): their open figures on the statements list were too low before the fix.`,
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
