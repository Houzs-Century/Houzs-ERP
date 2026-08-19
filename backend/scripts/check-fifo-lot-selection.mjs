// Read-only: what do the FIFO consumption functions actually key their lot
// selection on?
//
// The 2026-08-19 tenant check answered half the question — neither
// scm.fn_consume_fifo nor scm.fn_consume_fifo_batch mentions company_id
// ANYWHERE. That is a finding, not a verdict, and the difference matters more
// here than almost anywhere else in the system: these are the functions that
// consume stock and set cost.
//
// The verdict turns on ONE thing this prints and nothing in the repository can:
// does the SELECT that picks lots key on warehouse_id?
//
//   IF YES  — a warehouse uuid belongs to exactly one company, so "consume the
//             oldest lot AT THIS WAREHOUSE" cannot reach the other company's
//             stock. The absent company_id costs nothing, and calling it a leak
//             would be a false alarm on the stock ledger.
//   IF NO   — lots are picked by item + variant across the whole
//             table, and 2990's stock can be consumed to satisfy a HOUZS
//             movement. That is a money-and-stock defect that outranks
//             everything else currently open.
//
// These functions exist in NO file in this repository — migs 0088 and 0195 only
// CALL them, so they were created directly against production, the same way
// CLAUDE.md records for the four hand-ported unique indexes. pg_get_functiondef
// is the only place the answer lives.
//
// Strictly read-only: one catalogue SELECT, no DDL, no writes, no transaction.
// Exits 0 on every legitimate answer including the bad one — the ANSWER is the
// output, and a red job reads as "the check broke".
// RE-RUN: idempotent. It reads and prints; running it twice changes nothing.
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
  console.error("check-fifo-lot-selection: no DATABASE_URL (env or backend/.dev.vars).");
  process.exit(1);
}

/* Asserted before anything is reported — see the note inside. */
function nearLots(body, col) {
  // NO REGEX, deliberately. Three attempts to write this as one died on escaping
  // — a template literal ate a backslash each time and produced `[sS]`, which
  // matches nothing. A matcher that never fires reports "keys on NEITHER", i.e.
  // it invents a money-and-stock emergency. String search cannot fail that way.
  for (let from = 0; ; ) {
    const i = body.indexOf("inventory_lots", from);
    if (i < 0) return false;
    const w = body.slice(i, i + 600);
    const j = w.indexOf(col);
    if (j >= 0 && w.slice(j + col.length).trimStart().startsWith("=")) return true;
    from = i + 1;
  }
}
{
  const yes = "from scm.inventory_lots l where l.warehouse_id = p_wh and qty_remaining > 0";
  const no = "from scm.inventory_lots l where l.variant_key = p_v and qty_remaining > 0";
  const far = "from scm.inventory_lots l where variant_key = p" + " x".repeat(400) + " company_id = 1";
  if (!nearLots(yes, "warehouse_id") || nearLots(no, "warehouse_id")
      || nearLots(yes, "company_id") || nearLots(far, "company_id")) {
    console.error("check-fifo-lot-selection: SELF-TEST FAILED — not reporting.");
    process.exit(2);
  }
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const NL = String.fromCharCode(10);

try {
  const fns = await pg`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'scm' AND p.proname LIKE 'fn_consume_fifo%'
     ORDER BY p.proname`;

  if (fns.length === 0) {
    console.log("NOT FOUND in scm. Migs 0088 and 0195 call these, so if they do not");
    console.log("exist those calls would fail — check the search_path before concluding");
    console.log("anything. An empty result here is a finding, not a clean bill.");
  }

  for (const f of fns) {
    const def = String(f.def);
    const lines = def.split(NL);
    console.log("");
    console.log(`-- ${f.name} ${"-".repeat(Math.max(0, 58 - f.name.length))}`);

    // Print only what decides the question: every line from an inventory_lots
    // mention to the end of that statement, plus any ORDER BY (the "FIFO" part).
    let inLots = false;
    lines.forEach((l, i) => {
      const low = l.toLowerCase();
      if (low.includes("inventory_lots")) inLots = true;
      if (inLots || low.includes("order by")) {
        console.log(`   ${String(i + 1).padStart(4)}  ${l.trim().slice(0, 110)}`);
        if (l.trim().endsWith(";")) inLots = false;
      }
    });

    // The two questions, asked of the text near the lots read rather than of the
    // whole body — a company_id 300 lines away in an INSERT is a STAMP, and a
    // stamp is not a predicate.
    const body = def.toLowerCase();
    const near = (col) => nearLots(body, col);
    const byWarehouse = near("warehouse_id");
    const byCompany = near("company_id");

    console.log("");
    console.log(`   lot selection keys on warehouse_id : ${byWarehouse}`);
    console.log(`   lot selection keys on company_id   : ${byCompany}`);
    console.log("");
    if (byWarehouse) {
      console.log("   VERDICT: SAFE by construction. A warehouse belongs to exactly one");
      console.log("            company, so the absent company_id cannot reach the other");
      console.log("            company's lots. Do NOT 'fix' this — see the header.");
    } else if (byCompany) {
      console.log("   VERDICT: explicitly company-scoped.");
    } else {
      console.log("   VERDICT: *** NEITHER. Lot selection is bounded by neither warehouse");
      console.log("            NOR company, so one company's movement can consume the");
      console.log("            other's stock and take its cost. Money-and-stock defect —");
      console.log("            escalate above everything else open. ***");
    }
  }

  console.log("");
  console.log("-- read-only. Nothing was written. ------------------------------");
} catch (e) {
  console.error(`check-fifo-lot-selection: query failed — ${e.message}`);
  await pg.end({ timeout: 5 });
  process.exit(1);
}

await pg.end({ timeout: 5 });
