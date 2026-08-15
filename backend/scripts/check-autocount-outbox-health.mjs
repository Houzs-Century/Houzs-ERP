// Read-only health report on the ERP -> AutoCount write-back queue.
//
// WHY THIS EXISTS. The queue is durable, retries, dead-letters and records
// everything it was ever asked to do — and its only OUTPUT is a console.error
// inside a Cloudflare Worker. Nobody is reading `wrangler tail` at 11pm. The
// coverage assessment put it plainly: "the queue without this is a queue nobody
// reads", and a `failed` row means a document exists in the ERP and does not
// exist in AutoCount, which is the exact divergence the whole mechanism exists
// to prevent.
//
// It answers four questions, and each one has a different remedy:
//
//   FAILED       a document gave up. It is in the ERP and not in the account
//                book. Someone has to look.
//   PENDING AGE  the oldest row that has not gone. With MAX_ATTEMPTS = 6 on a
//                fixed 5-minute cron, a row gives up permanently after roughly
//                30 minutes of outage, so a climbing age is the early warning
//                that the tunnel is down and the dead-lettering has started.
//   SKIPPED      the ERP declined to send, ON PURPOSE, and each reason is a
//                different backlog: a refusal needs a line-key backfill, a
//                merged conversion needs a human, a parentless document can
//                never exist in AutoCount at all.
//   SENT         the shape of what HAS gone, so "nothing is failing" can be
//                told apart from "nothing is happening".
//
// Strictly read-only: SELECTs, no DDL, no writes, no transaction. Exits 0 for
// every legitimate answer — including a completely empty queue, which is the
// correct state today — because a red job reads as "the check broke" and the
// ANSWER is the output. Only an unreachable database exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* The taxonomy is no longer this script's private property. The ERP now has a
   PAGE over the same table (scm/routes/autocount-outbox.ts), and two readers
   with two copies of the classification is how a screen and a workflow log
   start disagreeing about the same row. src/scm/lib/autocount-outbox-status.ts
   is the source; this is its plain-node mirror, and a canonical test fails if
   they drift. */
import { AC_SKIP_KINDS, REQUEUE_NOTE_PREFIX } from "./lib/autocount-skip-kinds.mjs";

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

/* The reason strings the ERP writes when it declines to send live in
   AC_SKIP_KINDS, imported above. Each is produced by a named code path, so a
   bucket that grows tells you WHICH path — and each carries a stable `kind`
   that the ERP page uses as its URL filter, which is why the list moved out of
   this file rather than being copied into a second one. */

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [flag, counts, oldest, failed, skipped] = await Promise.all([
    /* THE SWITCH ITSELF, not a sentence about it. Until this line existed the
       script described `scm.autocount_writeback` in prose and never read it, so
       "is the write-back on" could only be answered from a document — and the
       documents were a day stale. It is the first gate `enqueueSoCreate` hits
       (autocount-outbox.ts) and it decides whether saving an SO queues anything
       at all, so it belongs at the top of this report. */
    pg`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`,
    pg`SELECT status, count(*)::int AS n FROM scm.autocount_outbox GROUP BY status ORDER BY status`,
    /* EVERY pending row, WITH last_error. A retrying row carries the reason its
       last attempt failed, and that reason is the whole diagnosis — 4xx fails
       immediately, so a row that is still RETRYING means the request reached
       AutoCount and AutoCount threw (AcSyncService turns every exception into a
       500). Reporting only age and attempt count said "something is wrong" and
       withheld the one field that says what, so the only way to read it was to
       wait ~30 minutes for the row to dead-letter into 'failed', which this
       script does print. */
    pg`SELECT doc_type, doc_no, op, attempts, last_error,
              (now() - created_at) AS age
         FROM scm.autocount_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    pg`SELECT doc_type, doc_no, op, attempts, last_error, created_at
         FROM scm.autocount_outbox
        WHERE status = 'failed'
        ORDER BY created_at DESC
        LIMIT 25`,
    pg`SELECT doc_type, doc_no, op, coalesce(last_error, '') AS last_error
         FROM scm.autocount_outbox
        WHERE status = 'skipped'
        ORDER BY created_at DESC`,
  ]);

  /* Report the raw value AND what the code makes of it. The parser
     (autocount-writeback-flag.ts) fails CLOSED: absent, empty, 'off', or
     anything it cannot parse all mean nothing is queued or sent. Printing the
     raw string too means a typo like 'On ' is visible rather than hidden behind
     the word "off". */
  const raw = flag.length ? flag[0].value : null;
  const v = (raw ?? '').trim().toLowerCase();
  const on = v === 'all' || /^[0-9]+(\s*,\s*[0-9]+)*$/.test(v);
  notice(
    `WRITE-BACK SWITCH scm.autocount_writeback = ${raw === null ? 'ROW ABSENT' : JSON.stringify(raw)}` +
      ` -> ${on ? `ON for ${v === 'all' ? 'every company' : 'company ' + v}` : 'OFF'}` +
      `. ${on
        ? 'Saving a document in those companies QUEUES it; the 5-min cron sends it.'
        : 'Saving a document queues NOTHING — every enqueue returns early.'}`,
  );
  if (on) {
    notice(
      'The switch is not the last gate: the send also needs AC_SYNC_URL (wrangler.toml) ' +
        'and the AC_SYNC_KEY secret. A missing key reaches the host and comes back 401 ' +
        "\"bad key\" — that shows up as failed rows below, not as an empty queue. " +
        'Worker secrets cannot be read from the database; use `wrangler secret list`.',
    );
  }

  const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const total = counts.reduce((a, r) => a + r.n, 0);

  /* A RE-QUEUED skip is history, not backlog.
     This table is append-only and a skipped row is never deleted, so once the
     re-queue tool has asked the question again the ORIGINAL refusal would
     otherwise sit in this report forever, sending an operator to fix something
     that is already fixed and already queued. requeue-autocount-skipped.mjs
     prefixes the reason with `[re-queued <when> -> outbox <id>]`
     (REQUEUE_NOTE_PREFIX in src/scm/lib/autocount-requeue.ts — this script runs
     under plain node against postgres.js and cannot import it, so the literal
     lives in both places). The row keeps status 'skipped', because it IS still
     true that nothing was ever sent for it; what changed is that it is no longer
     the open question. */
  const settled = skipped.filter((r) => r.last_error.startsWith(REQUEUE_NOTE_PREFIX));
  const outstanding = skipped.filter((r) => !r.last_error.startsWith(REQUEUE_NOTE_PREFIX));

  if (total === 0) {
    notice("QUEUE EMPTY — zero rows of any status.");
    /* What empty MEANS depends on the switch read above, so say which. The old
       text always claimed empty was "correct while the flag is off" — true only
       while it was off, and actively misleading the moment it was turned on. */
    notice(
      "That is not 'drained'. The table is append-only by design, so an empty " +
        "table means NOTHING HAS EVER BEEN ENQUEUED — " +
        (on
          ? "and the switch is ON, so this means no document has been saved yet. " +
            "Save one and re-run; if it is still empty afterwards, the enqueue " +
            "itself is not being reached."
          : "which is the expected state while scm.autocount_writeback is off."),
    );
  } else {
    notice(
      `queue: ${total} row(s) — ` +
        ["pending", "sent", "failed", "skipped"]
          .map((s) => `${s} ${by[s] ?? 0}`)
          .join(" / ") +
        (settled.length ? ` (${settled.length} of the skipped have been re-queued)` : ""),
    );
  }

  /* FAILED is the one that means a document diverged. */
  if ((by.failed ?? 0) > 0) {
    notice(`FAILED: ${by.failed} — each is a document that is in the ERP and NOT in AutoCount.`);
    for (const r of failed) {
      notice(`  ${r.doc_type} ${r.doc_no} (${r.op}, ${r.attempts} attempts): ${String(r.last_error ?? "").slice(0, 300)}`);
    }
  } else {
    notice("FAILED: 0");
  }

  if (oldest.length) {
    const o = oldest[0];
    notice(`PENDING: ${oldest.length} row(s). Oldest ${o.doc_type} ${o.doc_no} (${o.op}), waiting ${o.age}, ${o.attempts} attempt(s)`);
    notice(
      "A pending row is not an error by itself — it is only one if the age keeps " +
        "climbing. MAX_ATTEMPTS is 6 on a 5-minute cron, so a row dead-letters " +
        "after roughly 30 minutes of the service being unreachable.",
    );
    /* The reason each one is still going round. A first attempt has none. */
    for (const r of oldest) {
      const why = String(r.last_error ?? "").trim();
      if (!why) continue;
      notice(`  ${r.doc_type} ${r.doc_no} (attempt ${r.attempts}) last error: ${why.slice(0, 400)}`);
    }
    if (oldest.some((r) => String(r.last_error ?? "").trim())) {
      notice(
        "A RETRYING row means the send was not a 4xx: configuration and bad-payload " +
          "errors are refused on the first attempt and land in 'failed' straight away. " +
          "So the request reached the host and AutoCount itself threw — AcSyncService " +
          "turns every exception into a 500, and the text above is AutoCount's own words.",
      );
    }
  } else {
    notice("oldest PENDING: none");
  }

  /* SKIPPED, classified. Unclassified rows are printed rather than counted
     away: a reason this script does not recognise is a code path that grew a
     new refusal, and rolling it into 'other' is how it stays invisible. */
  if (outstanding.length > 0) {
    const seen = new Set();
    for (const { needle, remedy: meaning } of AC_SKIP_KINDS) {
      const hits = outstanding.filter((r) => r.last_error.includes(needle));
      hits.forEach((r) => seen.add(r.doc_no + r.op));
      if (!hits.length) continue;
      notice(`  skipped ${hits.length}: ${meaning}`);
      /* NAME THE DOCUMENTS AND QUOTE THE REASON. A bare count tells an operator
         that something was refused but not what to open, and the message body
         carries the specifics the class name cannot — which line, which item
         code, what the resolver actually found. Without this the only way to
         act on a skip was to go query the table by hand. */
      for (const r of hits) {
        notice(`    - ${r.doc_type} ${r.doc_no} (${r.op}): ${r.last_error.slice(0, 400)}`);
      }
    }
    const rest = outstanding.filter((r) => !seen.has(r.doc_no + r.op));
    for (const r of rest) {
      notice(`  skipped (UNRECOGNISED reason): ${r.doc_type} ${r.doc_no} (${r.op}): ${r.last_error.slice(0, 200)}`);
    }
  } else {
    notice(`SKIPPED: 0 outstanding${settled.length ? ` (${settled.length} re-queued, below)` : ""}`);
  }

  if (settled.length) {
    notice(
      `RE-QUEUED: ${settled.length} skipped row(s) have been asked again by the re-queue workflow. ` +
        "Each one's document is a PENDING row above (or already sent); these are the record of the " +
        "refusal, not an open item.",
    );
    for (const r of settled) {
      notice(`  - ${r.doc_type} ${r.doc_no} (${r.op}): ${r.last_error.slice(0, 300)}`);
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
