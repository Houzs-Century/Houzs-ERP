// Read-only: can the PO Amendments queues silently lose their "From SO
// amendment" rows?
//
// WHY THIS EXISTS
//
// GET /so-amendments (backend/src/scm/routes/so-amendments.ts) fills each row's
// `bound_pos` from three unpaged, company-unscoped PostgREST reads whose errors
// were discarded, and both PO Amendments queues show an SO amendment only when
// `bound_pos` is non-empty. A refused URL, a truncated answer or a failed read
// therefore empties the queue's SO-driven rows with nothing on screen to say so.
// That is a reading of the code. Whether production is near any of those edges
// is a fact about production, and this reports it, per company:
//
//   - the rows GET /so-amendments lists and how many of them the PO queue shows;
//   - the rows each of the three reads must return (the response ceiling);
//   - the byte length of each read's request line, built by the real client;
//   - whether any SO number, line or PO binding crosses companies.
//
// The statements live in scripts/lib/so-amendment-bound-po-reads.mjs, where
// tests-pg/soAmendmentBoundPoReadsSql.pg.test.ts executes them against real
// Postgres.
//
// COUNTS AND SIZES ONLY. The repository is public and so is every Actions log: no
// SO number, id, customer or amount is printed.
//
// Two SELECTs inside one READ ONLY transaction with a statement timeout, so the
// database itself refuses anything but a read. Exits 0 for every answer; only an
// unreachable database or a failed query exits non-zero.
//
// RE-RUN: harmless. It writes nothing, so a second run reads the same tables
// again and differs only by whatever staff raised or approved in between.
import { appendFileSync, readFileSync } from "node:fs";
import postgres from "postgres";
import {
  assessCompany,
  assessScope,
  describeCompany,
  describeScope,
  measureBoundPoReads,
  measureRequestTargets,
} from "./lib/so-amendment-bound-po-reads.mjs";

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
  const { companies, scope } = await pg.begin("read only", async (tx) => {
    await tx`SET LOCAL statement_timeout = '120s'`;
    return measureBoundPoReads(tx);
  });

  console.log(
    `PO Amendments "From SO amendment" rows — read-only, counts only. Observed ${new Date().toISOString()}.`,
  );
  if (companies.length === 0) {
    notice("ZERO ROWS — no SO amendment carries a company. This answers nothing about the queue.");
  }

  const summary = [];
  for (const row of companies) {
    const targets = await measureRequestTargets(row);
    const assessed = assessCompany(row, targets);
    console.log("");
    for (const line of describeCompany(assessed)) console.log(line);
    for (const v of assessed.verdicts) {
      const say = v.kind === "WITHIN_LIMITS" || v.kind === "EMPTY" ? notice : warning;
      say(`company ${assessed.facts.companyId}: ${v.kind} — ${v.text}`);
      summary.push(`| ${assessed.facts.companyId} | ${v.kind} | ${v.text} |`);
    }
  }

  const scoped = assessScope(scope);
  console.log("");
  for (const line of describeScope(scoped)) console.log(line);
  for (const v of scoped.verdicts) {
    (v.kind === "NO_COLLISION" ? notice : warning)(`scope: ${v.kind} — ${v.text}`);
    summary.push(`| all | ${v.kind} | ${v.text} |`);
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
