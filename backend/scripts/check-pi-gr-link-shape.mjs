#!/usr/bin/env node
/* check-pi-gr-link-shape — NAME the invoice-line links whose shape is wrong, and
 * (with an explicit confirm) take back only those.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * repair-pi-gr-links.mjs applied 26 links on production in run
 * 34275605452 and its own read-back then refused the batch:
 *
 *     verify (fresh connection): linked 26/26 · dangling 0 · wrong company 0 · wrong item 1
 *     VERIFY FAILED: a link points at another company's receipt or at another item.
 *
 * The guard worked — it is the reason this is a known problem and not a silent
 * one. But it reported a COUNT, so the run ended knowing that one of 26 links
 * is wrong and not WHICH. A shape check that cannot name its offender leaves
 * the operator with 26 suspects and no way to act, which is most of the value
 * of having checked. The write had already happened by then: the read-back runs
 * after the UPDATE, by design, because it is verifying what landed.
 *
 * So this does two things, in the repo's usual order:
 *   MODE=report (default)  names every one of the 26, with BOTH item codes and
 *                          the book's own, and says which fail the shape.
 *   MODE=revert            sets `grn_item_id` back to NULL for the failing rows
 *                          ONLY, and only where the row still holds exactly the
 *                          value the committed plan wrote. Anything else is
 *                          left alone and named.
 *
 * ── WHY REVERT AND NOT "FIX" ──────────────────────────────────────────────
 * A link whose two sides disagree about the item is not evidence of the right
 * answer, it is evidence that the derivation is wrong for that row. Blank is
 * the honest state — the same rule the matcher already follows, and the same
 * one docs/bugs/0730 records: a blank beats a wrong link.
 *
 * ── IT MOVES NO STOCK ─────────────────────────────────────────────────────
 * One column, `grn_item_id`, set to NULL on at most a handful of rows.
 * `pg_trigger` is read on the live database first and the run refuses if
 * anything fires on scm.purchase_invoice_items or scm.grn_items, exactly as the
 * repair does. 「库存先不看」.
 *
 * RE-RUN: inert. A row already NULL is not in the failing set and is not
 * touched; a second revert finds nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN_FILE = path.join(here, "data", "pi-gr-line-links-plan.json");
const CONFIRM_PHRASE = "TAKE BACK THE WRONG LINKS";

const DSN = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "report").toLowerCase();
const REVERT = MODE === "revert";
const CO = Number(process.env.COMPANY_ID || 1);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const bad = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m);
  process.exit(2);
};

if (!DSN) bad("need DATABASE_URL");
if (REVERT && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=revert requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=report first and read it.`);
}
if (!fs.existsSync(PLAN_FILE)) bad(`${PLAN_FILE} is not in the tree; this checks what that plan wrote.`);
const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
note(`plan ${plan.digest} — ${plan.writes.length} link(s) written by the apply`);

/* The same assertion the repair makes, for the same reason. */
async function assertNothingFires(client) {
  for (const tbl of ["scm.purchase_invoice_items", "scm.grn_items"]) {
    const rows = await client`
      SELECT t.tgname FROM pg_trigger t
       WHERE t.tgrelid = ${tbl}::regclass AND NOT t.tgisinternal`;
    if (rows.length) {
      bad(`${tbl} carries ${rows.length} trigger(s) (${rows.map((r) => r.tgname).join(", ")}). ` +
          "Refusing — stock is deferred.");
    }
  }
  note("verified on the live database: nothing fires on scm.purchase_invoice_items or scm.grn_items");
}

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const ids = plan.writes.map((w) => w.piItemId);
    const rows = await sql`
      SELECT pii.id::text            AS pi_item_id,
             pii.item_code           AS pi_item_code,
             pii.grn_item_id::text   AS grn_item_id,
             gi.item_code            AS gr_item_code,
             gi.id IS NULL           AS dangling,
             g.company_id            AS gr_company,
             g.grn_number            AS grn_number,
             g.linked_ac_gr_docno    AS gr_doc,
             h.invoice_number        AS invoice_number
        FROM scm.purchase_invoice_items pii
        JOIN scm.purchase_invoices h ON h.id = pii.purchase_invoice_id
        LEFT JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
        LEFT JOIN scm.grns g ON g.id = gi.grn_id
       WHERE pii.id = ANY(${ids}::uuid[])
       ORDER BY h.invoice_number, pii.id`;
    const byId = new Map(rows.map((r) => [r.pi_item_id, r]));

    const failing = [];
    say("\n── THE 26 LINKS THE APPLY WROTE, WITH BOTH SIDES' ITEM CODES");
    say(`   ${"invoice".padEnd(16)} ${"our PI item".padEnd(26)} ${"our GR item".padEnd(26)} ${"book item".padEnd(24)} verdict`);
    for (const w of plan.writes) {
      const r = byId.get(w.piItemId);
      if (!r) {
        say(`   ${String(w.invoiceNumber).padEnd(16)} (row not read back)`);
        continue;
      }
      const why = [];
      if (r.grn_item_id == null) why.push("link is NULL now");
      else if (r.dangling) why.push("points at no receipt line");
      else {
        if (String(r.gr_company) !== String(CO)) why.push(`receipt is company ${r.gr_company}`);
        if (String(r.pi_item_code ?? "") !== String(r.gr_item_code ?? "")) why.push("ITEM CODES DIFFER");
      }
      const okRow = why.length === 0;
      if (!okRow && r.grn_item_id != null) failing.push({ w, r, why: why.join("; ") });
      say(`   ${String(r.invoice_number).padEnd(16)} ${String(r.pi_item_code ?? "").slice(0, 25).padEnd(26)} ` +
          `${String(r.gr_item_code ?? "").slice(0, 25).padEnd(26)} ${String(w.itemCode ?? "").slice(0, 23).padEnd(24)} ` +
          `${okRow ? "ok" : why.join("; ")}`);
    }

    say(`\n${failing.length} of ${plan.writes.length} link(s) fail the shape.`);
    if (failing.length === 0) {
      note("nothing to take back.");
      return;
    }
    for (const f of failing) {
      say(`   ${f.r.invoice_number}  ${f.w.piDocNo} line ${f.w.piDtlKey} -> ${f.w.grDocNo} line ${f.w.grDtlKey}`);
      say(`      our invoice line says "${f.r.pi_item_code}", the receipt line we linked says "${f.r.gr_item_code}",`);
      say(`      and the book named "${f.w.itemCode}" on both. ${f.why}.`);
      say(`      how it was paired: ${f.w.how}`);
    }

    if (!REVERT) {
      note("MODE=report — nothing written. To take these back: MODE=revert with the confirm phrase.");
      return;
    }

    await assertNothingFires(sql);
    let cleared = 0;
    for (const f of failing) {
      /* Only where the row STILL holds exactly what the plan wrote. If somebody
         has re-pointed it since, their answer wins and this leaves it alone. */
      const res = await sql`
        UPDATE scm.purchase_invoice_items SET grn_item_id = NULL
         WHERE id = ${f.w.piItemId}::uuid AND grn_item_id = ${f.w.grnItemId}::uuid`;
      cleared += res.count;
    }
    note(`took back ${cleared} link(s) of ${failing.length} failing`);

    /* Fresh connection, shape not count: every row named above must now be NULL
       and every OTHER row the plan wrote must still be linked and still sound. */
    const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
    try {
      const failIds = failing.map((f) => f.w.piItemId);
      const keepIds = plan.writes.map((w) => w.piItemId).filter((id) => !failIds.includes(id));
      const [a] = await check`
        SELECT count(*) FILTER (WHERE grn_item_id IS NOT NULL)::int AS still_linked
          FROM scm.purchase_invoice_items WHERE id = ANY(${failIds}::uuid[])`;
      const [b] = await check`
        SELECT count(*)::int AS linked,
               count(*) FILTER (WHERE gi.item_code IS DISTINCT FROM pii.item_code)::int AS wrong_item
          FROM scm.purchase_invoice_items pii
          JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
         WHERE pii.id = ANY(${keepIds}::uuid[])`;
      note(`verify (fresh connection): reverted rows still linked ${a.still_linked} (must be 0) · ` +
           `kept rows linked ${b.linked}/${keepIds.length}, wrong item ${b.wrong_item} (must be 0)`);
      if (a.still_linked !== 0) bad("VERIFY FAILED: a row that should have been taken back is still linked.");
      if (b.wrong_item !== 0) bad("VERIFY FAILED: a kept link still has mismatched item codes.");
      if (b.linked !== keepIds.length) {
        bad(`VERIFY FAILED: expected ${keepIds.length} kept links, read back ${b.linked}.`);
      }
      note("verify OK — the wrong links are blank, and every link left standing has matching item codes.");
    } finally {
      await check.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
