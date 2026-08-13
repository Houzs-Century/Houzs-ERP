// Re-attempt AutoCount write-backs the ERP REFUSED, once the cause is fixed.
//
// A refused document lands in scm.autocount_outbox as a `skipped` row carrying
// the reason. That row is terminal: no route path re-attempts a CREATE for a
// document that already exists, and enqueueEdit bails on a document with no
// linked_ac_docno — so setting the stock location the composer complained about
// changes nothing at all, and the order never reaches the account book. This is
// the "ask again" that did not exist.
//
//   DOC_NO=HC-SO-2608-002              one document
//   DOC_TYPE=SO|PO|ALL                 every skipped row of that type (default ALL)
//   APPLY=1                            write. WITHOUT IT THIS IS A DRY RUN.
//
// WHY THIS RUNS UNDER `tsx` AND NOT AS A PLAIN .mjs SCRIPT
// --------------------------------------------------------
// The requirement that decides the shape: re-COMPOSE, never resurrect the old
// payload — the whole point is that the document changed since it was refused.
// The composer is TypeScript the Worker runs (src/services/autocount-writeback.ts
// + src/scm/lib/autocount-outbox.ts) and this is a script. Three ways to bridge
// that, and only one of them keeps a single implementation:
//
//   1. Re-implement the enqueue in .mjs.        REJECTED OUTRIGHT. A second copy
//      of composeCreateSo, the D9 sofa collapse, the D10 item resolution and the
//      location rules would drift from the real one, and the day it drifts is
//      the day this tool pushes a document the real composer would have refused
//      — into a live licensed account book.
//
//   2. An admin-only HTTP route on the Worker that this workflow calls. It was
//      the obvious answer and it is genuinely defensible — the Worker already
//      holds the composer. It was NOT chosen because of what it costs to reach:
//      the Worker authenticates callers by session or by a service key, GitHub
//      Actions holds neither, so it needs a NEW Worker secret plus a NEW Actions
//      secret before the tool can run once — and it puts a permanent write
//      endpoint on the public Worker whose only caller is a manual workflow. A
//      recovery tool that cannot be run until somebody provisions credentials is
//      a recovery tool that is not there when it is needed.
//
//   3. Import the REAL TypeScript enqueue into a Node process and run it against
//      the SAME PostgREST client the Worker builds.  <- this one.
//      enqueueSoCreate / enqueuePoCreate are pure supabase-js with no Cloudflare
//      binding anywhere in their path, so they execute verbatim under `tsx`.
//      This is the repo's established answer to exactly this problem, not a new
//      idea: recompute-2990-so-allocation.mjs, recompute-so-allocation.mjs,
//      restamp-do-actual-cost.mjs and check-status-disagreement-why.mjs all run
//      `npx tsx` over a .mjs script that imports the canonical function from
//      src/ for the stated reason that the alternative is a re-implementation.
//
// The dry run is not a prediction either — see captureWrites in
// src/scm/lib/autocount-requeue.ts. It runs the real enqueue against the real
// document and records the write instead of performing it, so DRY RUN and APPLY
// take the identical code path and can only disagree about whether the row lands.
//
// Access path: PostgREST (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, schema
// `scm`), NOT the pg DATABASE_URL, because that is what the enqueue speaks.
//
// Run: npx tsx scripts/requeue-autocount-skipped.mjs            (DRY RUN)
//      APPLY=1 npx tsx scripts/requeue-autocount-skipped.mjs    (writes)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requeueSkipped } from "../src/scm/lib/autocount-requeue.ts";

const APPLY = process.env.APPLY === "1" || process.argv.includes("--apply");
const DOC_NO = (process.env.DOC_NO || "").trim();
const DOC_TYPE = (process.env.DOC_TYPE || "ALL").trim().toUpperCase();

if (!["ALL", "SO", "PO"].includes(DOC_TYPE)) {
  console.error(
    `DOC_TYPE ${JSON.stringify(DOC_TYPE)} is not one of ALL / SO / PO. Only SO and PO have an ` +
      "AutoCount create to re-attempt; DO / GR / IV / PI are built by transferring a parent's " +
      "lines and have no create route at all.",
  );
  process.exit(2);
}

// Resolve one field from .dev.vars for local runs WITHOUT printing the value
// (repo secret-safety rule: match the field, never echo the raw line). CI passes
// these as env, so this branch is local-only.
function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const SUPABASE_URL = process.env.SUPABASE_URL || fromDevVars("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fromDevVars("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the Houzs Supabase REST creds). " +
      "These are Worker secrets; they must also exist as GitHub Actions secrets for the workflow to run.",
  );
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// The SAME client getSupabaseService() builds: service role, default schema
// `scm`, so every sb.from('autocount_outbox') inside the enqueue resolves to
// scm.autocount_outbox unchanged.
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "scm" },
  auth: { persistSession: false, autoRefreshToken: false },
});

/* One line per outcome, in the operator's vocabulary. The verb says whether
   anything happened; the detail says what to do next. */
const HEADLINE = {
  "would-requeue": "WOULD RE-QUEUE",
  requeued: "RE-QUEUED",
  "still-refused": "STILL REFUSED",
  "not-recoverable": "not re-queueable here",
  "already-in-autocount": "already in AutoCount",
  "already-queued": "already queued",
  "already-requeued": "already re-queued earlier",
  "document-gone": "document gone",
  "switch-off": "write-back switch is OFF",
  declined: "declined",
};

try {
  notice(
    `mode=${APPLY ? "APPLY" : "DRY RUN"} scope=${DOC_NO ? `doc ${DOC_NO}` : `${DOC_TYPE} skipped rows`}`,
  );

  const results = await requeueSkipped(sb, {
    docNo: DOC_NO || null,
    docType: DOC_TYPE,
    apply: APPLY,
  });

  if (!results.length) {
    notice(
      DOC_NO
        ? `No skipped outbox row for ${DOC_NO}. Nothing was refused for that document, or it was ` +
            "never enqueued at all (the write-back switch was off when it was saved)."
        : "No skipped rows in scope. The refusal backlog is empty.",
    );
    process.exit(0);
  }

  for (const r of results) {
    notice(`${HEADLINE[r.outcome] ?? r.outcome}: ${r.docType} ${r.docNo} (${r.op}) — ${r.detail}`);
    /* The ORIGINAL reason, printed under every outcome, because that is the
       thing the operator went and fixed. Seeing "STILL REFUSED" next to a
       different message than last time is the whole signal: one cause was
       cleared and the next one behind it is now the blocker. */
    if (r.originalReason) notice(`    was: ${r.originalReason.slice(0, 400)}`);
  }

  const tally = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
  notice(
    `${results.length} skipped row(s) examined — ` +
      Object.entries(tally)
        .map(([k, n]) => `${k} ${n}`)
        .join(" / "),
  );

  if (!APPLY) {
    const ready = tally["would-requeue"] ?? 0;
    notice(
      ready
        ? `DRY RUN — nothing written. ${ready} document(s) would be re-queued. Re-run with apply=1.`
        : "DRY RUN — nothing written, and nothing is ready to re-queue. Fix the causes above first.",
    );
  } else if (tally.requeued) {
    notice(
      `${tally.requeued} document(s) queued. They send on the next 5-minute cron sweep; confirm with ` +
        "the 'AutoCount write-back queue — health (read-only)' workflow, which is where a failure " +
        "would show up. Re-running this is safe: a re-queued document is already pending, and this " +
        "reports it as already-queued rather than queueing it twice.",
    );
  }
} catch (e) {
  console.error(`requeue-autocount-skipped failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
