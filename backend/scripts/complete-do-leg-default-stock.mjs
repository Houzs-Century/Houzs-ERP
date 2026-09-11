// Complete the leg-default repair that a FIRST apply left half-done
// (docs/bugs/0722). The apply tool (apply-do-leg-default-stock.mjs) committed
// its raw-SQL half — stripped legHeight from the delivery lines and deleted the
// phantom OUT movements — and then FAILED at the canonical re-ship because it
// passed a non-UUID string for performed_by (inventory_movements.performed_by is
// uuid, nullable). No money or stock moved: the phantom OUTs it deleted had zero
// consumptions and zero cost, and the target lots were never decremented. But
// the three DOs are now SHIPPED with clean lines and NO stock OUT at all.
//
// The original tool can no longer find this work: it scopes on OUT movements
// carrying legheight=default, and it already deleted them. So this recovery
// targets the three DOs by number and does only the remaining half — the
// canonical re-ship — with a VALID performed_by (null, the system-write norm:
// 3487 of 4201 live movements carry a null performer).
//
// PRECONDITION IT ASSERTS (refusing loudly otherwise): for each DO, no line
// still carries legHeight, there is no OUT for the sofa item_codes, and the
// target lot is still open. If any of that is false the partial state is not
// what this was written for, and it stops rather than guess.
//
// THE WORK, per DO: resyncInventoryForDo nets per bucket — the pillow lines
// match (delta 0), the sofa lines have a target and no OUT (delta +1), so it
// books exactly the missing OUTs; the FIFO trigger consumes the real lot at its
// real cost; resync restamps the DO lines. Then restampSiFromDo carries it to
// the Sales Invoice. No stock or costing logic here; both are the canonical
// functions, reached through the pgrest-shim, under tsx — as restamp-do-actual-
// cost.mjs does.
//
// RE-RUN: convergent. Once a DO has its sofa OUT booked, the precondition
// "no OUT for the sofa item_codes" is false, so this refuses it as already done.
// A second APPLY with every DO complete writes nothing.
//
// RUN. DRY-RUN (default): DATABASE_URL only, reports the plan, writes nothing.
//   APPLY: APPLY=1 CONFIRM="COMPLETE THE FIVE STRANDED LINES".
//   Under tsx (the TS imports): npx tsx scripts/complete-do-leg-default-stock.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const CONFIRM_PHRASE = "COMPLETE THE FIVE STRANDED LINES";
const WANTS_APPLY = process.env.APPLY === "1";
// The only comparison of CONFIRM lives in the guard below, adjacent to its exit.
const APPLY = WANTS_APPLY;

const DO_NUMBERS = ["HC-DO-2609-004", "HC-DO-2609-009", "HC-DO-2609-011"];
const SOFA_ITEM_CODES = ["5535-2A(LHF)", "5535-L(RHF)", "9028-2A(RHF)", "9028-L(LHF)", "8051-STOOL"];

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
// CONFIRM is compared HERE, with the refusing exit adjacent (release-discipline).
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(2);
}

async function main() {
  notice(`\nCOMPLETE LEG-DEFAULT REPAIR — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing is written)"}`);
  const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

  /* Read the partial state for the three DOs and assert it is what this tool
     exists to finish. */
  const dos = await pg`
    SELECT d.id::text AS id, d.do_number, d.status::text AS status
      FROM scm.delivery_orders d
     WHERE d.do_number = ANY(${DO_NUMBERS})
     ORDER BY d.do_number`;

  const checks = [];
  for (const d of dos) {
    const legLeft = await pg`
      SELECT count(*)::int AS n FROM scm.delivery_order_items
       WHERE delivery_order_id = ${d.id}::uuid AND variants ? 'legHeight'`;
    const sofaOut = await pg`
      SELECT count(*)::int AS n FROM scm.inventory_movements
       WHERE source_doc_no = ${d.do_number} AND movement_type = 'OUT'
         AND item_code = ANY(${SOFA_ITEM_CODES})`;
    checks.push({
      doNo: d.do_number, docId: d.id, status: d.status,
      legLeft: legLeft[0].n, sofaOut: sofaOut[0].n,
    });
  }

  notice("\nPRECONDITION (the partial state this finishes):");
  let ok = true;
  for (const c of checks) {
    const good = c.legLeft === 0 && c.sofaOut === 0;
    notice(`   ${c.doNo} [${c.status}]  lines-with-legHeight=${c.legLeft}  sofa-OUT=${c.sofaOut}  ${good ? "-> will complete" : "-> UNEXPECTED, refusing this DO"}`);
    if (!good) ok = false;
  }
  if (dos.length !== DO_NUMBERS.length) {
    warn(`expected ${DO_NUMBERS.length} DOs, found ${dos.length}`);
    ok = false;
  }
  if (!ok) {
    console.error("\nThe partial state is not what this tool was written for (a DO still carries legHeight, or already has a sofa OUT). Refusing — nothing written. Re-read docs/bugs/0722 and the state before proceeding.");
    await pg.end();
    process.exit(1);
  }

  if (!APPLY) {
    notice(`\nDRY-RUN — every DO is in the expected partial state and would be re-shipped.`);
    notice(`To apply:\n  APPLY=1 CONFIRM="${CONFIRM_PHRASE}" npx tsx scripts/complete-do-leg-default-stock.mjs`);
    await pg.end();
    return;
  }

  /* ── Complete the re-ship, reusing the canonical functions via the shim ───── */
  const { resyncInventoryForDo } = await import("../src/scm/routes/delivery-orders-mfg.ts");
  const { restampSiFromDo } = await import("../src/scm/lib/recost.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const assertNoShimGaps = (ctx) => {
    if (sb.__gaps.length === 0) return;
    console.error(`SHIM GAP during ${ctx} — a canonical function called a method the shim does not implement; aborting so a silent skip can never read as success:`);
    for (const g of sb.__gaps) console.error(`  ${g}`);
    process.exit(1);
  };

  let done = 0;
  const failures = [];
  for (const c of checks) {
    try {
      // performed_by is nullable and null is the system-write norm — NOT a string.
      await resyncInventoryForDo(sb, c.docId, null);
      assertNoShimGaps(`resyncInventoryForDo(${c.doNo})`);
      await restampSiFromDo(sb, c.docId);
      assertNoShimGaps(`restampSiFromDo(${c.doNo})`);
      notice(`   ${c.doNo}: re-shipped + restamped.`);
      done++;
    } catch (e) {
      failures.push({ doNo: c.doNo, error: String(e?.message ?? e) });
    }
  }
  notice(`\nWRITTEN: ${done} of ${checks.length} DO(s); failures ${failures.length}`);
  for (const f of failures) warn(`   FAILED ${f.doNo}: ${f.error}`);
  await pg.end();

  /* ── Verify on a FRESH connection ───────────────────────────────────────── */
  const v = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const after = await v`
    SELECT d.do_number,
           (SELECT count(*) FROM scm.inventory_movements m
             WHERE m.source_doc_no = d.do_number AND m.movement_type = 'OUT'
               AND m.item_code = ANY(${SOFA_ITEM_CODES}) AND COALESCE(m.total_cost_sen,0) > 0) AS costed_sofa_out,
           (SELECT COALESCE(SUM(di.line_cost_centi),0) FROM scm.delivery_order_items di
             WHERE di.delivery_order_id = d.id AND di.item_code = ANY(${SOFA_ITEM_CODES})) AS sofa_line_cost_centi
      FROM scm.delivery_orders d
     WHERE d.do_number = ANY(${DO_NUMBERS})
     ORDER BY d.do_number`;
  await v.end();

  notice("\nVERIFY (fresh connection):");
  let bad = 0;
  for (const r of after) {
    const good = Number(r.costed_sofa_out) > 0 && Number(r.sofa_line_cost_centi) > 0;
    notice(`   ${r.do_number}  costed sofa OUT=${r.costed_sofa_out}  sofa line cost=${rm(Number(r.sofa_line_cost_centi))}  ${good ? "OK" : "STILL INCOMPLETE"}`);
    if (!good) bad++;
  }
  if (failures.length > 0 || bad > 0) {
    console.error("\nFAILED — see above. What landed is reversible on the cancel path; nothing was deleted by this recovery.");
    process.exit(1);
  }
  notice("\nOK — all three DOs re-shipped at real cost; stock decremented, COGS stamped, SI restamped.");
  notice("If SO stock allocation looks stale, run the SO allocation recompute (docs/bugs/0675).");
}

main().catch((e) => { console.error(e); process.exit(1); });
