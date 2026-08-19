// Read-only: why can this person not find this Sales Order in the Service Case
// picker?
//
// WHY THIS EXISTS. 2026-08-19: a salesperson reported that "Create Service Case"
// stayed greyed out. The real symptom is one line above the button —
// "No matching sales orders." — so the submit is not broken, the SO lookup found
// nothing and the form refuses to submit without a linked order.
//
// GET /api/assr/search-so reads TWO sources and a bare `SO-XXXXXX` number can
// only come from the first:
//
//   1. `sales_orders`          the HOUZS AutoCount mirror. Bare SO-XXXXXX.
//                              SKIPPED ENTIRELY unless the caller's allowed
//                              company set includes HOUZS (assr.ts:1256-1260,
//                              the guard added after a 2990-only rep was seen
//                              reading HOUZS orders on 2026-07-22).
//   2. `scm.mfg_sales_orders`  the ERP's own orders, prefixed HC- / 2990-.
//
// So there are three candidate causes and they need different fixes. Guessing
// between them costs a person a working day, and the owner has already refuted
// the first one by hand ("他就是有" — he does hold HOUZS). This prints which one
// it actually is:
//
//   A. the user does not hold HOUZS      -> grant it on the Team screen
//   B. the row is not in the mirror      -> an AutoCount sync gap, not RBAC
//   C. the row IS there and they DO hold -> the query or the pattern, and this
//      HOUZS                                script prints the row so the next
//                                           reader can see what differs
//
// Inputs come from the workflow, never from a hardcode: SO_NO and USER (an email
// or a name fragment).
//
// Strictly read-only: four SELECTs, no DDL, no writes, no transaction.
// EXITS 0 for every legitimate answer — the ANSWER is the output.
// RE-RUN: idempotent. It reads and prints.
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
const soNo = (process.env.SO_NO ?? "").trim();
const who = (process.env.USER_Q ?? "").trim();

if (!url) {
  console.error("check-so-visible-to-user: no DATABASE_URL.");
  process.exit(1);
}
if (!soNo) {
  console.error("check-so-visible-to-user: SO_NO is required (e.g. SO-005263).");
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
// The SAME pattern the route builds: `%${q.toLowerCase()}%` against LOWER(doc_no).
const pattern = `%${soNo.toLowerCase()}%`;

try {
  console.log(`SO asked for : ${soNo}`);
  console.log(`LIKE pattern : ${pattern}`);
  console.log(`user filter  : ${who || "(none given)"}`);

  // 1. the AutoCount mirror, exactly as the route queries it
  const mirror = await pg`
    SELECT doc_no, debtor_name, doc_date, sales_agent
      FROM sales_orders
     WHERE LOWER(doc_no) LIKE ${pattern}
     ORDER BY doc_date DESC NULLS LAST
     LIMIT 5`;
  console.log("");
  console.log(`-- 1. AutoCount mirror (public.sales_orders) : ${mirror.length} row(s)`);
  for (const r of mirror) {
    console.log(`     ${r.doc_no}  ${r.debtor_name ?? "-"}  ${r.doc_date ?? "-"}  agent=${r.sales_agent ?? "-"}`);
  }

  // 2. the ERP's own orders
  const scm = await pg`
    SELECT doc_no, debtor_name, company_id, salesperson_id
      FROM scm.mfg_sales_orders
     WHERE LOWER(doc_no) LIKE ${pattern}
     LIMIT 5`;
  console.log("");
  console.log(`-- 2. ERP orders (scm.mfg_sales_orders)      : ${scm.length} row(s)`);
  for (const r of scm) {
    console.log(`     ${r.doc_no}  ${r.debtor_name ?? "-"}  company_id=${r.company_id}  salesperson=${r.salesperson_id ?? "-"}`);
  }

  // 3. NEAR MISSES — the row may exist under a different shape (padding, no
  //    dash, a suffix). Without this the answer "not found" cannot tell a sync
  //    gap apart from a formatting difference.
  const digits = soNo.replace(/\D/g, "");
  let near = [];
  if (digits) {
    near = await pg`
      SELECT doc_no, doc_date FROM sales_orders
       WHERE regexp_replace(doc_no, '\\D', '', 'g') = ${digits}
       LIMIT 5`;
  }
  console.log("");
  console.log(`-- 3. same DIGITS, any formatting            : ${near.length} row(s)`);
  for (const r of near) console.log(`     ${r.doc_no}  ${r.doc_date ?? "-"}`);
  if (digits && near.length && !mirror.length) {
    console.log("     ^ the order EXISTS but its doc_no is written differently, so the");
    console.log("       picker's LIKE never matches what the person types. Not RBAC.");
  }

  // 4. the person's company grants
  if (who) {
    const users = await pg`
      SELECT u.id, u.email, u.name, u.status,
             p.name AS position_name, d.name AS department_name,
             (SELECT string_agg(c.code, ',' ORDER BY c.code)
                FROM user_companies uc JOIN companies c ON c.id = uc.company_id
               WHERE uc.user_id = u.id) AS companies
        FROM users u
        LEFT JOIN positions p ON p.id = u.position_id
        LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.email ILIKE ${"%" + who + "%"} OR u.name ILIKE ${"%" + who + "%"}
       LIMIT 5`;
    console.log("");
    console.log(`-- 4. matching users                         : ${users.length} row(s)`);
    for (const u of users) {
      console.log(`     #${u.id}  ${u.name ?? "-"}  <${u.email ?? "-"}>  ${u.status}  companies=[${u.companies ?? "NONE"}]`);
      /* THE GATE IS TEXT, not a permission. canAccessServiceCases admits the
         service_cases.read holder OR isSalesUser OR isDirectorUser, and
         isSalesUser (services/pmsAccess.ts:146) tests `position_name` against a
         regex and `department_name` for the substring "sales". So a real
         salesperson whose POSITION or DEPARTMENT field is blank, or spelled some
         other way, is refused with a 403 that the picker used to render as
         "No matching sales orders". Printed here because it is the one RBAC
         input nobody would think to look at. */
      console.log(`          position="${u.position_name ?? ""}"  department="${u.department_name ?? ""}"`);
      const salesish = /sales/i.test(String(u.position_name ?? "")) || /sales/i.test(String(u.department_name ?? ""));
      console.log(`          reads as SALES to the gate: ${salesish}`);
    }
    const noHouzs = users.filter((u) => !String(u.companies ?? "").split(",").includes("HOUZS"));
    if (users.length && noHouzs.length === users.length) {
      console.log("     ^ none of these hold HOUZS, so assr.ts:1256 skips the AutoCount");
      console.log("       mirror entirely and a bare SO-XXXXXX can never be found. CAUSE A.");
    }
  }

  // the verdict, stated rather than left to the reader
  console.log("");
  console.log("-- VERDICT ------------------------------------------------------");
  if (mirror.length || scm.length) {
    console.log("   The order IS reachable by the picker's own query. So the cause is");
    console.log("   NOT a missing row: check section 4 — if the person does not hold");
    console.log("   HOUZS the mirror block is skipped for them (CAUSE A).");
  } else if (near.length) {
    console.log("   CAUSE B-formatting: the order exists but its doc_no is spelled");
    console.log("   differently from what was typed. Not RBAC, not a sync gap.");
  } else {
    console.log("   CAUSE B-sync: no row anywhere with that number or those digits.");
    console.log("   The order never reached this database. Look at the AutoCount");
    console.log("   inbound sync, not at permissions.");
  }
  console.log("");
  console.log("-- read-only. Nothing was written. ------------------------------");
} catch (e) {
  console.error(`check-so-visible-to-user: query failed — ${e.message}`);
  await pg.end({ timeout: 5 });
  process.exit(1);
}

await pg.end({ timeout: 5 });
