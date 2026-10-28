// Read-only report: how many ACTIVE users have ZERO `user_companies` grants?
//
// WHY THIS EXISTS (audit finding M2)
//
// `middleware/companyContext.ts` fails OPEN: when multi-company is active
// (>1 company) and a user has NO row in `user_companies`, they are given ALL
// active companies instead of none — so an un-provisioned account can read and
// write EVERY brand's data by setting the X-Company-Id header. Flipping that
// default to fail-CLOSED is safe ONLY once every real user has been granted at
// least one company; otherwise the flip would instantly lock those users out.
//
// The count that decides "is it safe to flip yet?" lives only in production, so
// answering it used to mean an owner opening a SQL console (the repo's standing
// rule forbids that). Actions already holds secrets.DATABASE_URL, so this runs
// there and nobody handles the credential.
//
// READING, NOT A SETTING. Strictly one SELECT, no DDL/writes/transaction. Exits
// 0 in every legitimate case — the ANSWER is the output; a red job would read as
// "the check broke". Only an unreachable DB / query error exits non-zero.
//
//   ungranted_active_users = 0  -> every active user has a grant. Safe to flip
//                                  companyContext to fail-closed.
//   ungranted_active_users > 0  -> those accounts currently see ALL brands. Grant
//                                  them a company FIRST, then re-run, then flip.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT
      (SELECT count(*) FROM public.companies)                          AS companies,
      (SELECT count(*) FROM public.users WHERE status = 'active')      AS active_users,
      (SELECT count(*) FROM public.users u
         WHERE u.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM public.user_companies uc WHERE uc.user_id = u.id
           ))                                                          AS ungranted_active_users`;

  const { companies, active_users, ungranted_active_users } = rows[0];
  const multiCompany = Number(companies) > 1;

  if (!multiCompany) {
    notice(
      `Single-company install (${companies} company): the companyContext fail-open cannot leak across brands. ` +
        `ungranted_active_users=${ungranted_active_users}/${active_users} is informational only.`,
    );
  } else if (Number(ungranted_active_users) === 0) {
    notice(
      `SAFE TO FLIP: every one of ${active_users} active users has a user_companies grant ` +
        `(${companies} companies). companyContext can move to fail-closed with no lockout.`,
    );
  } else {
    notice(
      `NOT YET: ${ungranted_active_users} of ${active_users} active users have ZERO user_companies grants ` +
        `across ${companies} companies. Each currently sees ALL brands (fail-open). Grant them a company ` +
        `before flipping companyContext to fail-closed, or those accounts get locked out.`,
    );
  }
  process.exit(0);
} catch (e) {
  console.error(`Query failed (DB unreachable or schema drift): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
