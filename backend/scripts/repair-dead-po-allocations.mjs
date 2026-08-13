// Dispatchable cleanup of STRANDED allocation sub-lines on cancelled/draft POs
// (2026-08-02, over-order audit section H0).
//
// THE DEFECT. mig-0235 allocation sub-lines (scm.purchase_order_item_allocations,
// rendered PO-xxxx-yy-NN) attribute a consolidated PO line across the customers
// it serves. When a PO is cancelled the handler releases the SO quota but — until
// the same-day handler fix — left the allocation rows behind. A CANCELLED PO must
// own NO attribution (the owner's rule, and the po-so-coverage layer-(b) intent),
// yet audit-mrp-pairing.mjs (H0) found rows on dead POs still naming a live SO.
//
// THE FIX has two halves: the cancel handler now clears allocations on cancel
// (prevention), and THIS script removes the rows stranded before that shipped
// (cleanup). It deletes EVERY allocation whose parent PO is CANCELLED or DRAFT —
// not only the live-SO ones the audit counts — because a dead PO attributes
// nothing regardless of the target SO's state.
//
// SAFE BY CONSTRUCTION. Allocations are attribution metadata only: they move no
// stock, no money, no po_qty_picked (mig-0235 table comment). Deleting them
// cannot change a balance, a COGS, or a ledger row. The coarse so_item_id on the
// PO line is untouched, so a reopen still re-claims quota and falls back to the
// 1:1 link.
//
// Env: DATABASE_URL (the only credential). APPLY=1 + CONFIRM="I HAVE REVIEWED THE
// DRY-RUN" to commit. Default is DRY-RUN: it prints every row it WOULD delete,
// grouped by PO, inside a transaction it then ROLLs BACK. Read-only until both
// gates are set.
//
// RE-RUN: inert. The allocations it deletes are gone; the rest are re-tested for being dead on every run.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const APPLY = process.env.APPLY === "1";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

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
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

async function planRows() {
  // Every allocation row whose parent PO is dead, with enough context to read
  // the plan: the PO number + status, the sub-number, and what it was claiming.
  return pg`
    SELECT a.id::text AS alloc_id,
           po.po_number,
           UPPER(po.status::text) AS po_status,
           a.seq,
           a.qty,
           a.so_item_id::text AS so_item_id,
           si.doc_no AS so_doc_no,
           si.cancelled AS so_cancelled,
           UPPER(COALESCE(so.status::text, '')) AS so_status,
           pi.company_id
      FROM scm.purchase_order_item_allocations a
      JOIN scm.purchase_order_items pi ON pi.id = a.purchase_order_item_id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = a.so_item_id
      LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no AND so.company_id = si.company_id
     WHERE UPPER(po.status::text) IN ('CANCELLED', 'DRAFT')
     ORDER BY po.po_number, a.seq`;
}

const SO_DONE = new Set(SO_TERMINAL_STATES);
const liveTarget = (r) => r.so_item_id && !r.so_cancelled && !SO_DONE.has(r.so_status);

async function main() {
  notice("=== REPAIR: strand allocation sub-lines on cancelled/draft POs ===");
  notice(APPLY ? "MODE: APPLY (will COMMIT if confirmation phrase matches)" : "MODE: DRY-RUN (rolls back — nothing written)");

  const rows = await planRows();
  if (rows.length === 0) {
    notice("Nothing to do: no allocation sub-lines exist on any cancelled/draft PO. Clean.");
    await pg.end();
    return;
  }

  const byPo = new Map();
  for (const r of rows) {
    const arr = byPo.get(r.po_number) ?? [];
    arr.push(r);
    byPo.set(r.po_number, arr);
  }
  const liveCount = rows.filter(liveTarget).length;
  notice(`Found ${rows.length} allocation sub-line(s) on ${byPo.size} dead PO(s); ${liveCount} still name a LIVE SO (the (H0) violation the audit counts).`);
  notice("");
  for (const [poNo, arr] of byPo) {
    notice(`  ${pad(poNo, 20)} ${pad("[" + arr[0].po_status + "]", 11)} ${arr.length} sub-line(s)`);
    for (const r of arr) {
      const tgt = r.so_item_id
        ? `${r.so_doc_no ?? "?"}${liveTarget(r) ? " (LIVE)" : ` (${r.so_cancelled ? "line-cancelled" : r.so_status || "done"})`}`
        : "STOCK slice";
      notice(`      ${pad(poNo + "-" + String(r.seq).padStart(2, "0"), 22)} qty ${pad(r.qty, 4)} -> ${tgt}`);
    }
  }
  notice("");

  const ids = rows.map((r) => r.alloc_id);

  // ONE transaction; per-statement savepoint is unnecessary for a single DELETE,
  // but the tx is what makes DRY-RUN a true no-op (BEGIN -> DELETE -> ROLLBACK).
  await pg.begin(async (tx) => {
    const del = await tx`DELETE FROM scm.purchase_order_item_allocations WHERE id::text IN ${tx(ids)}`;
    notice(`DELETE affected ${del.count} row(s).`);

    if (APPLY && CONFIRM === CONFIRM_PHRASE) {
      notice(`APPLIED — ${del.count} stranded allocation row(s) COMMITTED as deleted. Re-run the MRP pairing audit; (H0) allocation-on-dead-PO must now read 0.`);
      return; // commit
    }
    if (APPLY) {
      warn(`APPLY=1 but CONFIRM != "${CONFIRM_PHRASE}". Refusing to commit. Rolling back.`);
    } else {
      notice("DRY-RUN — rolling back. Review the plan above, then re-run with APPLY=1 and the confirmation phrase.");
    }
    throw new Error("ROLLBACK_SENTINEL");
  }).catch((e) => {
    if (e?.message === "ROLLBACK_SENTINEL") return;
    throw e;
  });
}

main().then(() => pg.end()).catch(async (e) => {
  console.error("REPAIR_DEAD_PO_ALLOCATIONS_FAIL", e?.message ?? e);
  await pg.end();
  process.exit(1);
});
