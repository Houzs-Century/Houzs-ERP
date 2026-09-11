// One-shot backfill: mark the AutoCount-imported HISTORICAL Sales Orders
// `open_to_all = true` so every user can see (and, subject to the state locks,
// edit) them. Owner 2026-09-11 ("把这些 sales order open to all").
//
// WHY A SCRIPT + WORKFLOW, NOT A MIGRATION. This flips real production rows by a
// data-dependent predicate. A numbered migration would re-run the UPDATE against
// every fresh/test database — none of which hold these rows — for no reason, and
// the CLAUDE.md rule keeps demo/data operations out of the numbered tree. The
// schema (the column + the view) ships as migration 20260911T1500; this only
// sets the flag, and is safe to run again (idempotent).
//
// THE TARGET — the go-live import, and ONLY that. Imported orders carry the
// AutoCount number in doc_no as `HC-SO-<6+ digits>` (e.g. HC-SO-000013 ..
// HC-SO-013518, ~2882 rows). NATIVE orders are `HC-SO-YYMM-NNN` (a month segment
// with a dash) or `2990-SO-...`, and must NOT be opened. `linked_ac_docno IS NOT
// NULL` is the WRONG filter: AutoCount write-back back-links native orders too,
// so ~57 native monthly orders also carry it. The doc_no shape is the honest
// discriminator, verified against production 2026-09-11:
//     HC-SO-[0-9]{6,}$   -> 2882 imported historical (open these)
//     HC-SO-YYMM-NNN     ->   59 native HOUZS  (leave)
//     2990-SO-...        ->  168 native 2990   (leave)
//
// SAFETY. The UPDATE sets exactly one column. scm.mfg_sales_orders has two
// triggers (canonicalize_venue on UPDATE OF venue; sync_access_staff_ids on
// UPDATE OF salesperson_id/collaborator_staff_ids/access_staff_ids) — neither
// fires for an open_to_all-only write. There is no updated_at trigger (the API
// maintains updated_at), so this does NOT bump updated_at and therefore cannot
// nudge any updated_at-watermark AutoCount delta sync. open_to_all has no
// counterpart on the AutoCount side, and a raw-SQL write does not run the
// application's write-back path regardless. Nothing here reaches AutoCount.
//
// DRY BY DEFAULT. Prints the counts + samples and writes nothing unless you pass
// `--apply`. Idempotent: only flips rows still false, so re-running after a
// partial run finishes the job and a fully-applied run reports zero to flip.
// Exits 0 for every legitimate answer; non-zero only for an unreachable DB.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Imported-historical discriminator. `{6,}` covers the padded 6-digit AutoCount
// numbers (max seen SO-013518) with headroom; the `$` rejects the YYMM-NNN
// native format, whose dash means it is not all-digits to end of string.
const TARGET_DOC_NO_RE = "^HC-SO-[0-9]{6,}$";

const APPLY = process.argv.includes("--apply");

// Same resolution order as pg-migrate.mjs / check-soak-gate.mjs: env wins so CI
// needs no .dev.vars. Match only the field and print nothing of the file.
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

// `notice` surfaces the verdict on the workflow run's summary page.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [counts] = await pg`
    SELECT
      count(*)                                        AS total_so,
      count(*) FILTER (WHERE doc_no ~ ${TARGET_DOC_NO_RE})                          AS matched,
      count(*) FILTER (WHERE doc_no ~ ${TARGET_DOC_NO_RE} AND open_to_all)          AS already_open,
      count(*) FILTER (WHERE doc_no ~ ${TARGET_DOC_NO_RE} AND NOT open_to_all)      AS to_flip
    FROM scm.mfg_sales_orders`;

  notice(`Sales Orders total            : ${counts.total_so}`);
  notice(`Imported-historical (matched) : ${counts.matched}   [doc_no ~ ${TARGET_DOC_NO_RE}]`);
  notice(`  already open_to_all         : ${counts.already_open}`);
  notice(`  to flip -> true             : ${counts.to_flip}`);

  const samples = await pg`
    SELECT doc_no FROM scm.mfg_sales_orders
    WHERE doc_no ~ ${TARGET_DOC_NO_RE}
    ORDER BY doc_no LIMIT 5`;
  notice(`samples: ${samples.map((r) => r.doc_no).join(", ")}`);

  if (!APPLY) {
    notice("DRY RUN — nothing written. Re-run with --apply to set open_to_all = true.");
  } else {
    const flipped = await pg`
      UPDATE scm.mfg_sales_orders
         SET open_to_all = true
       WHERE doc_no ~ ${TARGET_DOC_NO_RE}
         AND open_to_all = false
      RETURNING doc_no`;
    notice(`APPLIED — flipped ${flipped.length} order(s) to open_to_all = true.`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
