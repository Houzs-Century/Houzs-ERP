// Read-only probe: WHO holds Sales Orders, per company, and can the Salesperson
// Handover panel actually reach them?
//
// Owner 2026-09-09, trying to hand five resigned reps' orders to one person:
// three of them (Luke Yang, Shaung, Stephy) could not be FOUND in the panel's
// "Orders currently with" picker at all. That picker reads GET /staff, whose
// own comment says it is the FULL roster precisely because "an active-only list
// would hide the exact case this tool exists for" — but the endpoint then runs
// scopeStaffRowsToActiveCompany, and that rule buckets a staff row with NO
// linked Houzs user (scm/lib/staffCompanyScope.ts staffCompanyIds) to the 2990
// MIRROR company. A rep who never had an ERP login — which is the normal shape
// for someone imported from AutoCount and long resigned — is therefore INVISIBLE
// while HOUZS is the active company.
//
// So the panel's roster answers "who is in this company's staff list", and the
// question the operator actually has is "who holds this company's orders". Those
// are different sets, and this probe prints the second one.
//
// WHAT IT ANSWERS, per company, and nothing else:
//
//   1. Every salesperson_id that holds at least one non-cancelled Sales Order,
//      with the staff row's name / code / active flag / linked-user flag, the
//      order count, and — the column the operator needs — PICKER, which says
//      whether scopeStaffRowsToActiveCompany would show that person under THIS
//      company. A holder marked `no` is one the panel cannot select today.
//
//   2. MIGRATED, the count of that holder's orders carrying linked_ac_docno.
//      Those are the population the handover's per-order migrated-SO lock can
//      refuse (docs/modules/so-handover.md §3), so it is the realistic ceiling
//      on how many will actually move. It is an UPPER BOUND on the refusals, not
//      a prediction: while the lock reads `verdict:<companies>` the decision is
//      per document and an order that reconciles clean still moves. This probe
//      deliberately does NOT re-implement that verdict — a second opinion about
//      a lock is how two answers to one question start.
//
//   3. Orders with NO salesperson_id at all, split by whether the legacy `agent`
//      text names somebody. The handover tool keys on salesperson_id, so an
//      order in the `agent`-only bucket cannot be moved by it in any company.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job reads as "the check broke", and the ANSWER is
// the output. Only an unreachable database or a query error exits non-zero.
// Manual dispatch only, own concurrency group, never on a schedule.
//
// RE-RUN: safe and free. It reads and prints; running it twice changes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const note = (s) => console.log(`::notice::${s}`);
const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const num = (s, n) => String(s ?? "").padStart(n);

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error("No DATABASE_URL (env or backend/.dev.vars). Cannot answer.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

  try {
    const companies = await sql`
      SELECT id, code, name FROM public.companies ORDER BY id`;
    for (const co of companies) note(`company ${co.id} = ${co.code} (${co.name})`);

    /* The picker's own rule, computed here rather than guessed:
         linked + grants   -> those companies
         linked + 0 grants -> HOUZS base
         unlinked          -> the 2990 mirror
       Read staffCompanyScope.ts staffCompanyIds before changing this — the two
       must agree, and this file is the copy that can silently drift. */
    const houzs = companies.find((c) => c.code === "HOUZS")?.id ?? null;
    const mirror = companies.find((c) => c.code !== "HOUZS")?.id ?? null;
    note(`picker buckets: linked+ungranted -> ${houzs ?? "?"}, unlinked -> ${mirror ?? "?"}`);

    for (const co of companies) {
      note(`---- company ${co.id} (${co.code}): who holds non-cancelled Sales Orders ----`);

      const holders = await sql`
        SELECT so.salesperson_id                                   AS staff_id,
               COUNT(*)                                            AS orders,
               COUNT(*) FILTER (WHERE so.linked_ac_docno IS NOT NULL) AS migrated,
               MAX(s.name)                                         AS name,
               MAX(s.staff_code)                                   AS staff_code,
               BOOL_OR(s.active)                                   AS active,
               MAX(s.user_id)                                      AS user_id,
               COALESCE(ARRAY_AGG(DISTINCT uc.company_id)
                          FILTER (WHERE uc.company_id IS NOT NULL), '{}') AS grants
          FROM scm.mfg_sales_orders so
          LEFT JOIN scm.staff s        ON s.id = so.salesperson_id
          LEFT JOIN public.user_companies uc ON uc.user_id = s.user_id
         WHERE so.company_id = ${co.id}
           AND so.salesperson_id IS NOT NULL
           AND COALESCE(so.status, '') <> 'CANCELLED'
         GROUP BY so.salesperson_id
         ORDER BY COUNT(*) DESC`;

      if (holders.length === 0) {
        note("  (nobody holds a non-cancelled order in this company)");
        continue;
      }

      note(`  ${pad("NAME", 26)}${pad("CODE", 10)}${num("ORDERS", 7)}${num("MIGRATED", 9)}  ${pad("ACTIVE", 7)}${pad("PICKER", 7)}STAFF ID`);
      for (const h of holders) {
        /* No staff row at all: the order points at an id nothing resolves. The
           panel cannot show it and neither can any name lookup — worth seeing. */
        const orphan = h.name == null && h.staff_code == null;
        const buckets = orphan
          ? []
          : h.user_id != null
            ? (h.grants.length > 0 ? h.grants : houzs != null ? [houzs] : [])
            : mirror != null ? [mirror] : [];
        const inPicker = buckets.includes(co.id);
        note(
          `  ${pad(orphan ? "(no staff row)" : h.name, 26)}${pad(h.staff_code, 10)}` +
          `${num(h.orders, 7)}${num(h.migrated, 9)}  ${pad(h.active === true ? "yes" : h.active === false ? "no" : "-", 7)}` +
          `${pad(inPicker ? "yes" : "NO", 7)}${h.staff_id}`,
        );
      }

      const [unattributed] = await sql`
        SELECT COUNT(*)                                                        AS total,
               COUNT(*) FILTER (WHERE COALESCE(BTRIM(so.agent), '') <> '')     AS with_agent
          FROM scm.mfg_sales_orders so
         WHERE so.company_id = ${co.id}
           AND so.salesperson_id IS NULL
           AND COALESCE(so.status, '') <> 'CANCELLED'`;
      note(
        `  no salesperson_id: ${unattributed.total} order(s), of which ${unattributed.with_agent} ` +
        `name somebody in the legacy 'agent' text — the handover tool keys on ` +
        `salesperson_id and cannot move either kind.`,
      );
    }

    note("PICKER=NO means the Handover panel cannot select that person while this company is active. Switch company, or the picker needs to list order HOLDERS rather than the staff roster.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(`check-so-holders failed: ${e?.message ?? e}`);
  process.exit(1);
});
