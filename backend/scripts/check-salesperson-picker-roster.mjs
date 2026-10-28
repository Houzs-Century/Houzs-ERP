// Read-only diagnostic: WHO does the salesperson picker hide, and how many
// documents does that make unnameable?
//
// WHY THIS EXISTS AS A SCRIPT (CLAUDE.md "never ask the owner to run a query",
// and "a cause you have not observed is a hypothesis"). GET /staff/pickable
// ?onlySales=1 narrows the SO / SI / DR / consignment salesperson dropdowns to
// staff whose linked Houzs user has a position starting "Sales" or a department
// containing "sales" (scm/routes/staff.ts, owner 2026-07-22 — the narrowing is
// CORRECT and stays). Three screens then resolved a PERSON against that
// narrowed list, so everyone it excludes got a synthetic "(me)" salesperson, a
// blank "Collected By" and a "(former staff)" label. This reports the size of
// the excluded set and the number of live documents it touches, from the only
// place that knows: production.
//
// STRICTLY READ-ONLY — SELECTs only, no writes, no DDL, no transaction.
//
// PUBLIC REPO: prints COUNTS and POSITION NAMES only. No staff name, no email,
// no phone, no document number. Position names are already committed in
// services/positionAccessSnapshot.ts.
//
// RE-RUN: idempotent. It reads and prints; a second run changes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

/* The SQL twin of services/pmsAccess.isSalesUser:
     position_name matches /^sales/i        -> ILIKE 'sales%'
     department_name contains "sales"       -> ILIKE '%sales%'
   Department resolves users.department_id first, then the position's own
   department — the same COALESCE the route's own query uses. */
const IS_SALES = pg`
  (COALESCE(p.name, '') ILIKE 'sales%'
   OR COALESCE(d.name, pd.name, '') ILIKE '%sales%')`;

try {
  // ── (1) how big is the ACTIVE roster, and how much of it is linked ────────
  const [roster] = await pg`
    SELECT count(*)::int                                   AS active_rows,
           count(*) FILTER (WHERE s.user_id IS NOT NULL)::int AS linked,
           count(*) FILTER (WHERE s.user_id IS NULL)::int     AS unlinked
      FROM scm.staff s
     WHERE s.active IS TRUE`;
  notice(
    `(1) scm.staff ACTIVE: ${roster.active_rows} rows — ${roster.linked} linked to a Houzs user, ${roster.unlinked} unlinked`,
  );

  // ── (2) the onlySales split, by POSITION ─────────────────────────────────
  const split = await pg`
    SELECT COALESCE(p.name, '(no position)')            AS position_name,
           COALESCE(d.name, pd.name, '(no department)') AS department_name,
           ${IS_SALES}                                  AS pickable,
           count(*)::int                                AS staff_rows
      FROM scm.staff s
      JOIN public.users u          ON u.id = s.user_id
      LEFT JOIN public.positions p ON p.id = u.position_id
      LEFT JOIN public.departments pd ON pd.id = p.department_id
      LEFT JOIN public.departments d  ON d.id = u.department_id
     WHERE s.active IS TRUE
     GROUP BY 1, 2, 3
     ORDER BY pickable, staff_rows DESC, 1`;
  notice("(2) ACTIVE + LINKED staff, split by the onlySales=1 predicate:");
  let pickableCount = 0;
  let hiddenCount = 0;
  for (const r of split) {
    if (r.pickable) pickableCount += r.staff_rows;
    else hiddenCount += r.staff_rows;
    notice(
      `    ${r.pickable ? "PICKABLE" : "HIDDEN  "}  ${r.staff_rows.toString().padStart(3)}  ${r.position_name} / ${r.department_name}`,
    );
  }
  notice(
    `    => ${pickableCount} pickable, ${hiddenCount} HIDDEN. Every hidden person is one the pickers could not name.`,
  );

  // ── (3) live documents whose stored salesperson the picker cannot name ────
  //  This is the "(former staff)" population: the salesperson row is ACTIVE —
  //  the person is sitting at their desk — and the picker still hides them.
  for (const [label, table] of [
    ["sales orders", "scm.mfg_sales_orders"],
    ["sales invoices", "scm.sales_invoices"],
    ["consignment orders", "scm.consignment_orders"],
  ]) {
    try {
      const [row] = await pg`
        SELECT count(*)::int AS docs
          FROM ${pg.unsafe(table)} t
          JOIN scm.staff s   ON s.id = t.salesperson_id AND s.active IS TRUE
          JOIN public.users u ON u.id = s.user_id
          LEFT JOIN public.positions p ON p.id = u.position_id
          LEFT JOIN public.departments pd ON pd.id = p.department_id
          LEFT JOIN public.departments d  ON d.id = u.department_id
         WHERE NOT ${IS_SALES}`;
      notice(
        `(3) ${label}: ${row.docs} document(s) whose salesperson is ACTIVE staff the picker HIDES — each renders "(former staff)"`,
      );
    } catch (e) {
      // A table this deployment does not have is an answer, not a failure.
      notice(`(3) ${label}: not readable here (${String(e.message).split("\n")[0]})`);
    }
  }
} catch (e) {
  console.error(`read failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
