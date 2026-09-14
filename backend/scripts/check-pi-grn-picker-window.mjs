// Read-only: does the "Bill a Goods-Received Note" picker hide notes that still
// have something to bill?
//
// WHY THIS EXISTS
//
// GET /purchase-invoices/outstanding-grn-items (backend/src/scm/routes/
// purchase-invoices.ts) reads the newest 500 POSTED, not-held goods-received
// notes by received_at, and only THEN keeps the lines that still have
// qty_accepted - invoiced_qty - returned_qty > 0. The cap is spent on every
// posted note, fully billed or not, so once a company holds more than 500 of
// them an older note with unbilled lines drops out of the picker — and out of
// its search — with nothing on the screen to say so. The follow-up grn_items
// read is one unpaged `.in('grn_id', <up to 500 ids>)`, so it can also lose rows
// to PostgREST's response ceiling, or be refused for its URI length.
//
// That is a reading of the code. Whether production is past either edge is a
// fact about production, and this reports it, per company:
//
//   - posted, not-held notes, and how many carry an unbilled line;
//   - how many of those fall OUTSIDE the newest 500 (with tie bounds: the
//     handler orders by a date alone, so notes sharing the 500th note's date
//     land either side of the window arbitrarily);
//   - how many grn_items rows the newest 500 carry (the unpaged read);
//   - two facts a fix leans on: line vs note company_id agreement, and whether
//     scm.v_grn_outstanding agrees with the line arithmetic.
//
// The statements live in scripts/lib/pi-grn-picker-window.mjs, where
// tests-pg/piGrnPickerWindowSql.pg.test.ts executes them against real Postgres.
//
// COUNTS AND DATES ONLY. The repository is public and so is every Actions log:
// no document number, supplier, item or amount is printed.
//
// Two SELECTs — a catalogue lookup for the view, then the measurement. No DDL,
// no writes, no transaction. Exits 0 for every answer, including "hidden"; only
// an unreachable database or a failed query exits non-zero.
//
// RE-RUN: harmless. It writes nothing, so a second run reads the same tables
// again and differs only by whatever staff billed in between.
import { appendFileSync, readFileSync } from "node:fs";
import postgres from "postgres";
import {
  PICKER_WINDOW,
  assessCompany,
  describeCompany,
  measurePickerWindow,
} from "./lib/pi-grn-picker-window.mjs";

// Same resolution order as check-soak-gate.mjs: env wins so CI needs no .dev.vars.
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
const warning = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
const redact = (s) => String(s).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://<redacted>");

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const { hasView, rows } = await measurePickerWindow(pg);

  console.log(
    `Bill a Goods-Received Note picker — read-only, counts only. Window = the newest ${PICKER_WINDOW} ` +
      "POSTED, not-held GRNs by received_at, the handler's .limit(500).",
  );
  if (!hasView) warning("scm.v_grn_outstanding does not exist here; the view comparison is skipped, not passed.");

  if (rows.length === 0) {
    notice("ZERO ROWS — no POSTED, not-held goods-received note in any company. This answers nothing about the picker.");
  }

  const summary = [];
  for (const row of rows) {
    const assessed = assessCompany(row);
    console.log("");
    for (const line of describeCompany(assessed)) console.log(line);
    if (Number(row.received_at_null) > 0) {
      warning(`company ${row.company_id}: ${row.received_at_null} note(s) have no received_at; the handler sorts them FIRST.`);
    }
    for (const v of assessed.verdicts) {
      notice(`company ${assessed.facts.companyId}: ${v.kind} — ${v.text}`);
      summary.push(`| ${assessed.facts.companyId} | ${v.kind} | ${v.text} |`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY && summary.length > 0) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ["| company | verdict | detail |", "| --- | --- | --- |", ...summary, ""].join("\n"),
    );
  }
} catch (e) {
  console.error(`check failed: ${redact(e?.message ?? e)}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
