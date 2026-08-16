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
//   DOC_TYPE=SO|PO|DO|GR|IV|PI|ALL     every row of that type in scope (default ALL)
//   APPLY=1                            write. WITHOUT IT THIS IS A DRY RUN.
//   INCLUDE_FAILED=1                   also re-send documents AutoCount REFUSED,
//                                      not only ones the ERP declined to send.
//                                      Read the warning below before using it.
//                                      REQUIRED for DO / GR / IV / PI: those four
//                                      have no create, so the only thing
//                                      re-sendable about them is a FAILED
//                                      transfer, and a `skipped` one is one of
//                                      the three permanent shapes.
//
// WHY THIS RUNS UNDER `tsx` AND NOT AS A PLAIN .mjs SCRIPT
// --------------------------------------------------------
// The requirement that decides the shape: for a CREATE, re-compose — never
// resurrect the old payload, because the whole point is that the document
// changed since it was refused. (A TRANSFER is the opposite and has been since
// 2026-08-16: it has no create to compose, its stored payload IS the complete
// instruction, and re-sending that snapshot is what a retry means. The ladder
// keeps the two apart; see autocount-requeue.ts's header.)
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
// On the transfer path there is nothing to predict at all: the verdict is three
// recorded columns, and DRY RUN reads exactly the ones APPLY does.
//
// Access path: DATABASE_URL, through lib/pgrest-shim.mjs.
//
// The enqueue speaks PostgREST, so it needs a PostgREST-shaped client — but
// that does NOT mean it needs PostgREST credentials. The shim gives the same
// shape over the pg connection, and DATABASE_URL is the credential 286 of this
// repo's workflows already use. Copy recompute-so-allocation.yml, which does
// exactly this for the same reason.
//
// This shipped once wired to SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, copied
// from recompute-2990-so-allocation.yml — the ONE workflow in the repo that
// references those, three characters away from the working one by name, and
// broken for the same reason: neither secret exists in this repo, at repo
// level or in any of its three environments. The first dispatch failed on it.
//
// Run: npx tsx scripts/requeue-autocount-skipped.mjs            (DRY RUN)
//      APPLY=1 npx tsx scripts/requeue-autocount-skipped.mjs    (writes)
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  acRequeueAccepted,
  requeueSkipped,
  REQUEUE_DOC_TYPES,
} from "../src/scm/lib/autocount-requeue.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const APPLY = process.env.APPLY === "1" || process.argv.includes("--apply");
/* INCLUDE_FAILED widens the scope from "the ERP refused to send this" to "we
   sent it and AutoCount refused it". Those are different risks. A skipped row
   never left the building. A failed one did, and the C# create has no guard
   against a duplicate ERP document number — so if a document actually landed
   and only the reply was lost, re-sending writes a SECOND one into a licensed
   account book. Use it when the failure is known to have changed nothing:
   a foreign key rejects before the insert, an ambiguous 500 does not. */
const INCLUDE_FAILED = process.env.INCLUDE_FAILED === "1" || process.argv.includes("--include-failed");
const DOC_NO = (process.env.DOC_NO || "").trim();
const DOC_TYPE = (process.env.DOC_TYPE || "ALL").trim().toUpperCase();

/* The list comes from the module rather than being typed again here: it is the
   same set requeueSkipped narrows on, and a copy that fell behind would refuse a
   scope the ladder supports. */
const ALLOWED_DOC_TYPES = ["ALL", ...REQUEUE_DOC_TYPES];
if (!ALLOWED_DOC_TYPES.includes(DOC_TYPE)) {
  console.error(
    `DOC_TYPE ${JSON.stringify(DOC_TYPE)} is not one of ${ALLOWED_DOC_TYPES.join(" / ")}.`,
  );
  process.exit(2);
}
/* DO / GR / IV / PI have no create at all. Their only re-sendable row is a
   FAILED transfer — the service refused an instruction the ERP had already
   composed — and without INCLUDE_FAILED the sweep selects `skipped` only, so the
   run would report an empty scope and read as "nothing is wrong". Saying so is
   better than answering a question the operator did not ask. */
if (["DO", "GR", "IV", "PI"].includes(DOC_TYPE) && !INCLUDE_FAILED) {
  console.error(
    `DOC_TYPE=${DOC_TYPE} selects documents that have no AutoCount create, so the only thing that ` +
      "can be sent again is a transfer AutoCount itself refused. Re-run with INCLUDE_FAILED=1. " +
      "A SKIPPED row of these types is one of the three permanent shapes (raised with no parent, " +
      "merged from several sources, or a line subset the ERP cannot name) and no re-send fixes those.",
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
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// Same SHAPE getSupabaseService() builds, default schema `scm`, so every
// sb.from('autocount_outbox') inside the enqueue resolves to
// scm.autocount_outbox unchanged — it cannot tell the difference.
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const sb = pgrestShim(pg, "scm");

/* One line per outcome, in the operator's vocabulary. The verb says whether
   anything happened; the detail says what to do next. */
const HEADLINE = {
  "would-requeue": "WOULD RE-QUEUE",
  requeued: "RE-QUEUED",
  "requeued-as-recorded": "RE-QUEUED (the recorded transfer, unchanged)",
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
    includeFailed: INCLUDE_FAILED,
  });

  if (!results.length) {
    notice(
      DOC_NO
        ? `No re-queueable outbox row for ${DOC_NO}. Nothing was refused for that document, it was ` +
            "never enqueued at all (the write-back switch was off when it was saved), or its only " +
            "refusal is a FAILED one and INCLUDE_FAILED=1 was not given."
        : "No rows in scope. The refusal backlog is empty.",
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
    `${results.length} row(s) examined — ` +
      Object.entries(tally)
        .map(([k, n]) => `${k} ${n}`)
        .join(" / "),
  );

  /* Counted through the shared predicate, not by naming `requeued`: there are
     two accepted outcomes since 2026-08-16 and a hard-coded key would report a
     queued transfer as "nothing was queued". */
  const acceptedCount = results.filter((r) => acRequeueAccepted(r.outcome)).length;

  if (!APPLY) {
    const ready = tally["would-requeue"] ?? 0;
    notice(
      ready
        ? `DRY RUN — nothing written. ${ready} document(s) would be re-queued. Re-run with apply=1.`
        : "DRY RUN — nothing written, and nothing is ready to re-queue. Fix the causes above first.",
    );
  } else if (acceptedCount) {
    notice(
      `${acceptedCount} document(s) queued. They send on the next 5-minute cron sweep; confirm with ` +
        "the 'AutoCount write-back queue — health (read-only)' workflow, which is where a failure " +
        "would show up. Re-running this is safe: a re-queued document is already pending, and this " +
        "reports it as already-queued rather than queueing it twice.",
    );
  }
} catch (e) {
  console.error(`requeue-autocount-skipped failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  /* CLOSE THE POOL OR THE JOB NEVER ENDS.
   *
   * This script was written against supabase-js, which is HTTP: nothing to
   * close, and falling off the end exited. It now holds a `postgres` pool, and
   * an open pool keeps the event loop alive forever — so the FIRST run that
   * actually SUCCEEDED hung, while every earlier failure had exited cleanly
   * through process.exit(1) above. A green run that never ends looks like a
   * slow query, which is the worst way for this to present.
   *
   * Same finally the health check has had since it was written. */
  await pg.end({ timeout: 5 });
}
