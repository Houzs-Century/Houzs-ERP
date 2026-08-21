// Read-only census: what does company-scoping the Delivery Planning board's
// Service-Case (ASSR) rows actually DO to the board?
//
// WHY THIS EXISTS
//
// Owner ruling 2026-08-21: the Delivery Planning board must not show a Service
// Case belonging to a company the caller holds no grant for — 「这个也不可以啊」.
// The board's ASSR union (scm/routes/delivery-planning.ts, section 7b) reads
// `public.assr_cases` through raw env.DB SQL with NO company predicate, while
// /api/assr scopes the very same table with `assrCompanySql` (= the caller's
// granted companies). Adding that predicate is the fix.
//
// The predicate has ONE failure mode that reading code cannot rule out: a row
// whose `company_id` is NULL matches `company_id IN (1,2)` for NOBODY, so it
// would vanish from EVERY caller's board, not just the wrong company's. Whether
// such rows exist lives only in production. So does the answer to "how much of
// the board is even affected".
//
// The standing rule forbids putting the production DSN in front of a human for
// a SELECT, and Actions already holds `secrets.DATABASE_URL` for the deploy —
// so the count runs here.
//
// It answers four questions:
//
//   1. COLUMN — does `public.assr_cases` carry `company_id` at all, and is it
//      NULLable? (delivery-planning.ts:1155 claims "no scm company_id yet";
//      routes/assr.ts has been scoping on it since 2026-07-20, so one of those
//      two is stale. information_schema decides, not either comment.)
//   2. ORPHANS — how many BOARD-ELIGIBLE cases (open + carrying a driving date,
//      i.e. exactly the union's own WHERE) have a NULL or unknown company_id.
//      ANY non-zero here is a row that disappears from everyone's board, and is
//      a reason to backfill BEFORE the predicate ships.
//   3. SPLIT — the board-eligible cases per company, so the size of what a
//      single-company caller stops seeing is a number, not a guess.
//   4. WHO — how many active users are granted exactly one company, i.e. how
//      many people the ruling actually changes the board for. A caller granted
//      both companies sees an unchanged board.
//
// READING, NOT A SETTING. SELECTs only — no DDL, no writes, no transaction, one
// statement per question. Exits 0 for every legitimate answer: the ANSWER is the
// output, and a red job would read as "the check broke". Only an unreachable
// database or a query error exits non-zero.
//
// RE-RUN: safe and identical. It writes nothing.
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
  // ── 1. COLUMN ────────────────────────────────────────────────────────────
  const col = await pg`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'assr_cases'
       AND column_name  = 'company_id'
  `;
  console.log("── 1. does public.assr_cases carry company_id? ──");
  if (col.length === 0) {
    // Evidence is not a setting. If the column is genuinely absent the fix
    // cannot be "add the predicate" and this run is the finding.
    notice(
      "public.assr_cases has NO company_id column. The board predicate as designed CANNOT ship — the ASSR union has nothing to scope on, and /api/assr's own assrCompanySql would be scoping on a column that does not exist. STOP and re-read routes/assr.ts before writing any migration.",
    );
    process.exit(0);
  }
  console.log(
    `   company_id  ${col[0].data_type}  nullable=${col[0].is_nullable}`,
  );

  // ── 2 + 3. BOARD-ELIGIBLE CASES BY COMPANY ───────────────────────────────
  // The WHERE is a byte-for-byte mirror of the board union's own filter
  // (delivery-planning.ts section 7b): OPEN case carrying at least one driving
  // date. Anything outside it never reaches the board, scoped or not, so
  // counting it would overstate the blast radius.
  const split = await pg`
    SELECT a.company_id                              AS company_id,
           COALESCE(co.code, '(no companies row)')   AS company_code,
           COALESCE(co.is_active::text, '-')         AS company_active,
           COUNT(*)                                  AS cases
      FROM assr_cases a
      LEFT JOIN companies co ON co.id = a.company_id
     WHERE a.closed_at IS NULL
       AND a.archived_at IS NULL
       AND (a.customer_pickup_at IS NOT NULL
            OR a.do_date IS NOT NULL
            OR (a.inspection_visit_at IS NOT NULL AND a.inspection_by = 'own'))
     GROUP BY a.company_id, co.code, co.is_active
     ORDER BY a.company_id NULLS FIRST
  `;

  console.log("");
  console.log("── 2+3. board-eligible ASSR cases (the union's own WHERE) ──");
  if (split.length === 0) {
    console.log("   (none — no open case carries a driving date today)");
  } else {
    console.log("   company_id  code                 active  cases");
    for (const r of split) {
      console.log(
        `   ${String(r.company_id ?? "NULL").padEnd(10)}  ${String(r.company_code).padEnd(19)}  ${String(r.company_active).padEnd(6)}  ${r.cases}`,
      );
    }
  }

  const orphans = split
    .filter((r) => r.company_id == null || r.company_code === "(no companies row)")
    .reduce((n, r) => n + Number(r.cases), 0);
  const total = split.reduce((n, r) => n + Number(r.cases), 0);

  // ── 4. WHO THE RULING CHANGES THE BOARD FOR ──────────────────────────────
  // A caller granted BOTH companies sees an unchanged board; only a caller
  // granted exactly one loses rows. Counting active users by grant width turns
  // "who is affected" into a number.
  const grants = await pg`
    SELECT g.n AS companies_granted, COUNT(*) AS users
      FROM (
        SELECT uc.user_id, COUNT(DISTINCT uc.company_id) AS n
          FROM user_companies uc
          JOIN companies c ON c.id = uc.company_id AND c.is_active = 1
          JOIN users u     ON u.id = uc.user_id
         WHERE u.status = 'active'
         GROUP BY uc.user_id
      ) g
     GROUP BY g.n
     ORDER BY g.n
  `;
  console.log("");
  console.log("── 4. active users by number of granted ACTIVE companies ──");
  for (const r of grants) {
    console.log(`   granted ${r.companies_granted} company(ies):  ${r.users} user(s)`);
  }
  const single = grants
    .filter((r) => Number(r.companies_granted) === 1)
    .reduce((n, r) => n + Number(r.users), 0);

  console.log("");
  notice(
    orphans > 0
      ? `${orphans} of ${total} board-eligible Service Cases carry NO resolvable company_id. Those rows match NOBODY's allow-list and would drop off EVERY board, not just the wrong company's. Backfill them before the predicate ships, or ship it knowing that.`
      : `All ${total} board-eligible Service Cases resolve to a real company. Adding the caller's company predicate drops rows ONLY from a caller who was never granted that company — ${single} active user(s) hold exactly one company grant and are the people this changes the board for. A both-company grantee sees an unchanged board.`,
  );
  process.exit(0);
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
