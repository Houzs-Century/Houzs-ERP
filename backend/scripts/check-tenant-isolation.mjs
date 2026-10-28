// Read-only report on the four tenant-isolation questions that CANNOT be answered
// from this repository. Each one is currently UNKNOWN, and each one is blocking a
// decision or a fix.
//
// WHY THIS IS A SCRIPT AND A WORKFLOW
//
// CLAUDE.md: never ask the owner to run a query — build the check instead. Asking
// costs an interruption every time and puts the production DSN in front of a
// human for a SELECT. Actions already holds `secrets.DATABASE_URL` for the
// deploy, so the check runs there and nobody handles the credential. This file
// exists because that rule was broken during the 2026-08-19 cross-company audit:
// a `psql` snippet was handed to the owner to paste. This is the correction.
//
// THE FOUR QUESTIONS
//
// 1. ZERO-GRANT USERS — decides an owner question, not a defect.
//    `middleware/companyContext.ts` FAILS OPEN: a user with no `user_companies`
//    row is granted EVERY active company, and its comment says so deliberately
//    ("never lock anyone out by the mere presence of the feature"). Flipping it
//    to fail-closed is correct isolation and would instantly lock out anyone with
//    no grant row. Which of those two costs more depends entirely on this count:
//      0        -> flip it; nobody is affected.
//      non-zero -> those users need grant rows FIRST, then flip.
//
// 2. THE FIFO FUNCTIONS — genuinely unknown, not merely unread.
//    `scm.fn_consume_fifo` and `scm.fn_consume_fifo_batch` are CALLED by migs
//    0088 and 0195 and DEFINED in no file in this repository. They were created
//    directly against production, like the four unique indexes CLAUDE.md records
//    the same way. So whether their lot selection carries a company predicate
//    cannot be read here at any effort. `pg_get_functiondef` is the only source.
//    Reported as a boolean plus the line that matched, never as a full dump — a
//    function body can be long and this is a report, not an export.
//
// 3. SHARED ACCOUNT CODES — sizes the blast radius of mig 0306.
//    Mig 0297 gave company 1 the same AutoCount chart company 2 carries, which is
//    what turned the GL views' bare-code join into a many-to-many. This counts how
//    many codes are genuinely held by more than one company.
//
// 4. LINE / ENTRY COMPANY DISAGREEMENT — a real integrity check.
//    `journal_entry_lines.company_id` and `journal_entries.company_id` should
//    never disagree. If any row does, mig 0306's `l.company_id = a.company_id`
//    predicate and the GL stream's `j.company_id` would attribute the same line
//    to different companies. Expected zero; a non-zero answer is a finding that
//    needs its own repair and must not be discovered later by a report that
//    silently disagrees with itself.
//
// STRICTLY READ-ONLY: four SELECTs, no DDL, no writes, no transaction.
// EXITS 0 for every legitimate answer, including the uncomfortable ones — a red
// job reads as "the check broke", and here the ANSWER is the output. Only an
// unreachable database or a query error exits non-zero.
// RE-RUN: idempotent. It reads and prints; running it twice changes nothing.
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
  console.error("check-tenant-isolation: no DATABASE_URL (env or backend/.dev.vars).");
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const say = (s = "") => console.log(s);
const head = (n, t) => {
  say("");
  say(`── ${n}. ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
};

try {
  // ── 1. zero-grant users ────────────────────────────────────────────────────
  head(1, "Users with NO user_companies grant row");
  const grants = await pg`
    SELECT
      (SELECT count(*) FROM users)                                   AS total_users,
      (SELECT count(*) FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id))
                                                                     AS zero_grant,
      (SELECT count(*) FROM companies WHERE is_active = 1)           AS active_companies`;
  const g = grants[0];
  say(`   users total                 ${g.total_users}`);
  say(`   users with ZERO grants      ${g.zero_grant}`);
  say(`   active companies            ${g.active_companies}`);
  say("");
  if (Number(g.active_companies) < 2) {
    say("   VERDICT: multi-company is not active (<2 companies), so companyContext");
    say("            never consults user_companies at all. The fail-open branch is");
    say("            unreachable today; this becomes a live question on activation.");
  } else if (Number(g.zero_grant) === 0) {
    say("   VERDICT: every user holds at least one grant. Flipping companyContext");
    say("            to FAIL-CLOSED locks out nobody. Safe to do.");
  } else {
    say(`   VERDICT: ${g.zero_grant} user(s) would be locked out by a fail-closed flip.`);
    say("            They need grant rows FIRST. Do not flip before that.");
  }

  // ── 2. the FIFO functions ──────────────────────────────────────────────────
  head(2, "Do the FIFO consumption functions carry a company predicate?");
  const fns = await pg`
    SELECT p.proname AS name,
           pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'scm'
       AND p.proname IN ('fn_consume_fifo', 'fn_consume_fifo_batch')
     ORDER BY p.proname`;
  if (fns.length === 0) {
    say("   NOT FOUND in scm. Both are called by migs 0088 and 0195, so if they do");
    say("   not exist those calls would fail — check the schema search_path before");
    say("   concluding anything. This is a finding, not an empty result.");
  }
  for (const f of fns) {
    const lines = String(f.def).split("\n");
    const hits = lines
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /company_id/i.test(l));
    say(`   ${f.name}: ${hits.length > 0 ? "carries company_id" : "*** NO company_id ANYWHERE ***"}`);
    for (const [i, l] of hits.slice(0, 6)) say(`       line ${i}: ${l.trim().slice(0, 100)}`);
    if (hits.length > 6) say(`       ... and ${hits.length - 6} more line(s)`);
    // A mention is not a predicate — the fifth blind spot. Say which it looks
    // like rather than letting "carries company_id" read as "is scoped".
    const predicate = hits.some(([, l]) => /company_id\s*=|=\s*[a-z_.]*company_id/i.test(l));
    if (hits.length > 0) {
      say(`       shape: ${predicate ? "at least one looks like a PREDICATE (=)" : "mentions only — may be a STAMP, not a predicate"}`);
    }
  }

  // ── 3. account codes held by more than one company ─────────────────────────
  head(3, "Account codes present in more than one company's chart");
  const shared = await pg`
    SELECT count(*) AS shared_codes
      FROM (SELECT account_code
              FROM scm.accounts
             GROUP BY account_code
            HAVING count(DISTINCT company_id) > 1) x`;
  const totals = await pg`
    SELECT count(*) AS rows, count(DISTINCT account_code) AS codes,
           count(DISTINCT company_id) AS companies
      FROM scm.accounts`;
  say(`   accounts rows               ${totals[0].rows}`);
  say(`   distinct codes              ${totals[0].codes}`);
  say(`   companies with a chart      ${totals[0].companies}`);
  say(`   codes in >1 company         ${shared[0].shared_codes}`);
  say("");
  say("   Each shared code is one that the OLD bare-code join in v_gl_entries /");
  say("   v_account_balances fanned out across both charts (mig 0306 fixed it).");

  // ── 4. line / entry company disagreement ───────────────────────────────────
  head(4, "journal_entry_lines whose company disagrees with their entry");
  const mismatch = await pg`
    SELECT count(*) AS mismatched,
           (SELECT count(*) FROM scm.journal_entry_lines) AS total_lines
      FROM scm.journal_entry_lines l
      JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     WHERE l.company_id IS DISTINCT FROM j.company_id`;
  const m = mismatch[0];
  say(`   journal lines total         ${m.total_lines}`);
  say(`   line.company <> entry.company ${m.mismatched}`);
  say("");
  if (Number(m.mismatched) === 0) {
    say("   VERDICT: consistent. mig 0306's two predicates (l.company_id on the");
    say("            balances, j.company_id on the GL stream) agree by construction.");
  } else {
    say(`   VERDICT: ${m.mismatched} row(s) disagree. This is a FINDING: the trial`);
    say("            balance and the GL stream would attribute the same line to");
    say("            different companies. Needs its own repair — do not assume");
    say("            which side is right without asking the owner.");
  }

  say("");
  say("── read-only. Nothing was written. ─────────────────────────────────────");
} catch (e) {
  console.error(`check-tenant-isolation: query failed — ${e.message}`);
  await pg.end({ timeout: 5 });
  process.exit(1);
}

await pg.end({ timeout: 5 });
