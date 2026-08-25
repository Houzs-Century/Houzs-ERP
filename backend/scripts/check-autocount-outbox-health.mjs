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
//                book. Someone has to look. OUTSTANDING ones only — a failed
//                row carrying the re-queue marker has already been asked again
//                (#2189's includeFailed opt-in) and is reported under RE-QUEUED,
//                because calling it a divergence is a false statement about a
//                live account book.
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

/* ── THE ALARM (ALARM=1) ──────────────────────────────────────────────────
   This file's workflow said, in its own header: "When the sync is live and this
   needs to become an ALARM rather than a report, that is a different mechanism
   (somewhere a human actually looks), not a cron on this workflow."

   The sync went live 2026-08-13 and on 2026-08-21 the shop-floor service
   stopped answering. Thirteen documents piled up over TWO DAYS and the owner
   found out by noticing they were missing from the account book. Nothing was
   watching, so the outage's cost was almost entirely the delay in spotting it.

   THE OBJECTION IN THAT HEADER IS ANSWERED, NOT OVERRULED. It was about NOISE —
   "a production DB read on a schedule turns a real question into CI noise
   nobody reads". So this alarm is SILENT when the queue is healthy: the run
   passes, GitHub sends nothing, and nobody reads anything. It speaks only by
   FAILING, which is the one CI signal that reaches a person who is not looking.

   WHAT COUNTS AS STUCK, and why only these two:
     - an OUTSTANDING failed row. The document is in the ERP and not in the
       account book, nothing will retry it, and only a person can move it.
     - a pending row older than ALARM_PENDING_MINUTES (default 60). A pending
       row is NOT an error by itself — the drain is a 5-minute cron and a
       conversion legitimately waits for its parent. It becomes one when the age
       stops falling, which at 12x the drain interval it has.
   A skipped row is deliberately NOT an alarm: it is a statement about the
   document's shape, it does not change on its own, and firing daily forever on
   one hand-keyed receipt is exactly the noise the header refused. */
const alarm = { failedOutstanding: 0, pending: [] };

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/* The reason strings the ERP writes when it declines to send live in
   AC_SKIP_KINDS, imported above. Each is produced by a named code path, so a
   bucket that grows tells you WHICH path — and each carries a stable `kind`
   that the ERP page uses as its URL filter, which is why the list moved out of
   this file rather than being copied into a second one. */

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [flag, counts, byOp, oldest, failed, requeuedFailed, skipped] = await Promise.all([
    /* THE SWITCH ITSELF, not a sentence about it. Until this line existed the
       script described `scm.autocount_writeback` in prose and never read it, so
       "is the write-back on" could only be answered from a document — and the
       documents were a day stale. It is the first gate `enqueueSoCreate` hits
       (autocount-outbox.ts) and it decides whether saving an SO queues anything
       at all, so it belongs at the top of this report. */
    pg`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`,
    /* The re-queued split comes back WITH the totals, per status, because it
       has to be exact and the detail queries below are capped. `FILTER` counts
       the annotated rows in the same pass; the pattern is parameterised off the
       shared constant so the marker is never typed twice. */
    pg`SELECT status,
              count(*)::int AS n,
              count(*) FILTER (WHERE last_error LIKE ${`${REQUEUE_NOTE_PREFIX}%`})::int AS requeued
         FROM scm.autocount_outbox GROUP BY status ORDER BY status`,
    /* WHICH OPERATIONS HAVE EVER GONE THROUGH, and which have only ever been
       asked. This is the question the status totals cannot answer: `sent: 47`
       says the queue works and says NOTHING about whether an EDIT has ever
       changed a document in the account book — and on 2026-08-18 the generated
       coverage table still recorded `edit` as never demonstrated while 40-odd
       ERP call sites enqueued it. A per-op split turns "has this operation ever
       worked in production" from an assertion into a row.

       The newest host build per op comes with it (migration 0304): an operation
       that last succeeded under a build nobody runs any more has not been
       proven against the one that is running. */
    pg`SELECT op,
              count(*)::int                                        AS n,
              count(*) FILTER (WHERE status = 'sent')::int          AS sent,
              count(*) FILTER (WHERE status = 'failed')::int        AS failed,
              count(*) FILTER (WHERE status = 'skipped')::int       AS skipped,
              count(*) FILTER (WHERE status = 'pending')::int       AS pending,
              max(sent_at)                                         AS last_sent,
              max(host_built_at)                                   AS newest_host_build
         FROM scm.autocount_outbox
        GROUP BY op
        ORDER BY op`,
    /* EVERY pending row, WITH last_error. A retrying row carries the reason its
       last attempt failed, and that reason is the whole diagnosis — 4xx fails
       immediately, so a row that is still RETRYING means the request reached
       AutoCount and AutoCount threw (AcSyncService turns every exception into a
       500). Reporting only age and attempt count said "something is wrong" and
       withheld the one field that says what, so the only way to read it was to
       wait ~30 minutes for the row to dead-letter into 'failed', which this
       script does print. */
    pg`SELECT doc_type, doc_no, op, attempts, last_error,
              (now() - created_at) AS age,
              EXTRACT(EPOCH FROM (now() - created_at)) AS age_s
         FROM scm.autocount_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    /* OUTSTANDING failures only. A failed row carrying the re-queue marker has
       already been asked again — #2189 gave the tool an includeFailed opt-in —
       and listing it under "each is a document that is in the ERP and NOT in
       AutoCount" is a false statement about a live account book. It is reported
       under RE-QUEUED instead, with the skips. */
    pg`SELECT doc_type, doc_no, op, attempts, last_error, created_at
         FROM scm.autocount_outbox
        WHERE status = 'failed'
          AND (last_error IS NULL OR last_error NOT LIKE ${`${REQUEUE_NOTE_PREFIX}%`})
        ORDER BY created_at DESC
        LIMIT 25`,
    pg`SELECT doc_type, doc_no, op, attempts, last_error
         FROM scm.autocount_outbox
        WHERE status = 'failed' AND last_error LIKE ${`${REQUEUE_NOTE_PREFIX}%`}
        ORDER BY created_at DESC`,
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

  /* ── DOES THE ERP DOCUMENT STILL EXIST? ────────────────────────────────
     The FAILED heading says "each is a document that is in the ERP and NOT in
     AutoCount". After a go-live wipe that sentence goes FALSE without anything
     changing in this table: the export log is deliberately KEPT (it is the
     ERP's only memory of what it told the book) while the documents it names
     are deleted. Measured 2026-08-24, minutes after golive-wipe-hc apply: one
     failed row, HC-DO-2608-003, whose delivery order no longer exists. Left
     alone the daily watchdog would have alarmed on it every morning forever —
     the exact "CI noise nobody reads" this workflow's header refused.

     So a failed row whose document is gone is history, not backlog. It is still
     PRINTED, under its own heading, because the row is the record of what was
     attempted and deleting the document does not unsay it. It is simply not
     counted as something a person can act on, because there is nothing left to
     act on.

     One query, six document types, keyed the way the outbox keys them. */
  const liveDocs = failed.length
    ? await pg`
        SELECT 'SO' AS doc_type, doc_no          AS doc_no FROM scm.mfg_sales_orders
        UNION ALL SELECT 'PO', po_number              FROM scm.purchase_orders
        UNION ALL SELECT 'DO', do_number              FROM scm.delivery_orders
        UNION ALL SELECT 'IV', invoice_number         FROM scm.sales_invoices
        UNION ALL SELECT 'GR', grn_number             FROM scm.grns
        UNION ALL SELECT 'PI', invoice_number         FROM scm.purchase_invoices`
    : [];
  const liveKeys = new Set(liveDocs.map((r) => `${r.doc_type}:${r.doc_no}`));
  const stillInErp = (r) => liveKeys.has(`${r.doc_type}:${r.doc_no}`);
  const failedLive = failed.filter(stillInErp);
  const failedGone = failed.filter((r) => !stillInErp(r));

  const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const byRequeued = Object.fromEntries(counts.map((r) => [r.status, r.requeued]));
  const total = counts.reduce((a, r) => a + r.n, 0);
  /* OUTSTANDING per terminal state = the total minus the ones already asked
     again. Both, not just skips: see the query comment above. */
  const failedOutstanding = (by.failed ?? 0) - (byRequeued.failed ?? 0);
  /* THE ALARM READS THE SAME TWO NUMBERS THE REPORT DOES, not its own query.
     A watchdog that asks a different question from the report it is attached to
     is a watchdog that can disagree with the page a human then opens. */
  alarm.failedOutstanding = Math.max(0, failedOutstanding - failedGone.length);
  alarm.pending = oldest.map((r) => ({
    docType: r.doc_type, docNo: r.doc_no, op: r.op,
    ageS: Number(r.age_s ?? 0), age: String(r.age ?? ''),
  }));

  /* A RE-QUEUED skip is history, not backlog.
     This table is append-only and a skipped row is never deleted, so once the
     re-queue tool has asked the question again the ORIGINAL refusal would
     otherwise sit in this report forever, sending an operator to fix something
     that is already fixed and already queued. requeue-autocount-skipped.mjs
     prefixes the reason with `[re-queued <when> -> outbox <id>]`
     (REQUEUE_NOTE_PREFIX in src/scm/lib/autocount-requeue.ts — this script runs
     under plain node against postgres.js and cannot import it, so the literal
     lives in both places). The row keeps its terminal status, because it IS
     still true that nothing was ever sent for it (or that it failed); what
     changed is that it is no longer the open question. */
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
        (settled.length + requeuedFailed.length
          ? ` (${settled.length + requeuedFailed.length} of those have been re-queued)`
          : ""),
    );
  }

  /* PER OPERATION — the question the totals cannot answer.
     `sent: 47` says the queue works. It does not say whether an EDIT has ever
     changed a document in the account book, and that is the operation the ERP
     performs most once it is master. Printed for every op the queue has ever
     held, plus the ones it has NEVER held, because an operation with no row at
     all is the strongest form of "never proven" and a table that omits it reads
     like a clean bill. */
  if (byOp.length || total === 0) {
    const seen = new Map(byOp.map((r) => [r.op, r]));
    const ALL_OPS = [
      "create_so", "create_po", "so_to_do", "so_to_po",
      "po_to_gr", "do_to_iv", "gr_to_pi", "cancel", "edit",
    ];
    notice("PER OPERATION — has this one ever reached the account book through the QUEUE?");
    for (const op of ALL_OPS) {
      const r = seen.get(op);
      if (!r) {
        notice(`  - ${op.padEnd(10)} NEVER ENQUEUED — no row of any status`);
        continue;
      }
      const build = r.newest_host_build
        ? ` host build ${new Date(r.newest_host_build).toISOString().slice(0, 16)}`
        : " host build not recorded";
      notice(
        `  - ${op.padEnd(10)} ${r.sent > 0 ? `SENT ${r.sent}` : "NEVER SENT"}` +
          ` (of ${r.n}: failed ${r.failed}, skipped ${r.skipped}, pending ${r.pending})` +
          (r.last_sent ? ` last ${new Date(r.last_sent).toISOString().slice(0, 16)}` : "") +
          build,
      );
    }
    /* Any op the queue holds that the list above does not name. A ninth
       operation would otherwise be invisible here, and this script is one of
       the two readers of that table. */
    for (const r of byOp) {
      if (!ALL_OPS.includes(r.op)) {
        notice(`  - ${String(r.op).padEnd(10)} (not in this script's op list) sent ${r.sent} of ${r.n}`);
      }
    }
  }

  /* FAILED is the one that means a document diverged — the OUTSTANDING ones.
     A re-queued failure is history and is listed under RE-QUEUED below. */
  if (failedOutstanding > 0) {
    if (failedLive.length) {
      notice(`FAILED: ${failedLive.length} — each is a document that is in the ERP and NOT in AutoCount.`);
      for (const r of failedLive) {
        notice(`  ${r.doc_type} ${r.doc_no} (${r.op}, ${r.attempts} attempts): ${String(r.last_error ?? "").slice(0, 300)}`);
      }
    } else {
      notice(`FAILED: 0 outstanding${requeuedFailed.length ? ` (${requeuedFailed.length} re-queued, below)` : ""}`);
    }
    /* SEPARATE HEADING, not a footnote on the one above, because the remedy is
       the opposite: there is none, and none is needed. */
    if (failedGone.length) {
      notice(
        `FAILED — DOCUMENT DELETED SINCE: ${failedGone.length}. The ERP document no longer exists ` +
          '(a wipe, or someone deleted it), so this row is the record of an attempt and not ' +
          'something to send again. Nothing to do.',
      );
      for (const r of failedGone) {
        notice(`  ${r.doc_type} ${r.doc_no} (${r.op}): gone from the ERP`);
      }
    }
  } else {
    notice(`FAILED: 0 outstanding${requeuedFailed.length ? ` (${requeuedFailed.length} re-queued, below)` : ""}`);
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

  const requeuedAll = [...requeuedFailed, ...settled];
  if (requeuedAll.length) {
    notice(
      `RE-QUEUED: ${requeuedAll.length} row(s) (${requeuedFailed.length} failed, ${settled.length} skipped) ` +
        "have been asked again by the re-queue workflow. " +
        "Each one's document is a PENDING row above (or already sent); these are the record of the " +
        "refusal, not an open item.",
    );
    for (const r of requeuedAll) {
      notice(`  - ${r.doc_type} ${r.doc_no} (${r.op}): ${String(r.last_error ?? "").slice(0, 300)}`);
    }
  }
  /* WHICH MASTER, not just "a master". Every refusal this queue has recorded
     names a CONSTRAINT and not a VALUE: FK_SO_SalesAgent says the agent is
     missing and never says WHO, MissingLocationError names the lines and not
     the warehouse they should have had. So the one question a human then asks -
     "which agent? which location? which item?" - could only be answered by
     opening the payload in a SQL console, which is exactly what CLAUDE.md says
     never to require.

     The values come straight out of the stored payload, so this reports what
     was SENT rather than what the ERP holds now. That distinction matters: a
     row that failed a week ago failed on the data as it was then. */
  const stuck = await pg`
    SELECT doc_type, doc_no, op, status,
           payload -> 'body' ->> 'Agent'            AS agent,
           payload -> 'body' ->> 'SalesLocation'    AS sales_location,
           payload -> 'body' ->> 'PurchaseLocation' AS purchase_location,
           payload -> 'body' ->> 'CreditorCode'     AS creditor,
           payload -> 'body' -> 'Details'           AS details
      FROM scm.autocount_outbox
     WHERE status IN ('failed', 'skipped', 'pending')
     ORDER BY created_at DESC
     LIMIT 40`;

  if (stuck.length) {
    notice(
      `MASTER DATA ON THE STUCK ROWS — ${stuck.length} row(s). ` +
        "A foreign key names the CONSTRAINT; these are the VALUES behind it. " +
        "Each one has to exist in AutoCount, or /ensure-masters has to be able to open it.",
    );
    const agents = new Set();
    const locations = new Set();
    const items = new Set();
    for (const r of stuck) {
      const lines = Array.isArray(r.details) ? r.details : [];
      const lineLoc = [...new Set(lines.map((d) => (d?.Location ?? "").toString().trim()).filter(Boolean))];
      const lineItems = [...new Set(lines.map((d) => (d?.ItemCode ?? "").toString().trim()).filter(Boolean))];
      const blankLoc = lines.filter((d) => !(d?.Location ?? "").toString().trim()).length;
      if (r.agent) agents.add(r.agent);
      for (const l of lineLoc) locations.add(l);
      for (const i of lineItems) items.add(i);
      notice(
        `  - ${r.doc_type} ${r.doc_no} (${r.op}, ${r.status}): ` +
          `agent=${JSON.stringify(r.agent)} ` +
          `salesLocation=${JSON.stringify(r.sales_location)} ` +
          (r.purchase_location ? `purchaseLocation=${JSON.stringify(r.purchase_location)} ` : "") +
          (r.creditor ? `creditor=${JSON.stringify(r.creditor)} ` : "") +
          `lines=${lines.length}` +
          (blankLoc ? ` BLANK-LOCATION=${blankLoc}` : "") +
          (lineLoc.length ? ` lineLocations=${lineLoc.join("|")}` : "") +
          (lineItems.length ? ` items=${lineItems.slice(0, 6).join("|")}` : ""),
      );
    }
    /* The DISTINCT sets are the actual work list. One agent blocking eleven
       documents is one decision, not eleven. */
    if (agents.size) notice(`  DISTINCT AGENTS to check in AutoCount (${agents.size}): ${[...agents].join(" | ")}`);
    if (locations.size) notice(`  DISTINCT LINE LOCATIONS (${locations.size}): ${[...locations].join(" | ")}`);
    if (items.size) notice(`  DISTINCT ITEM CODES (${items.size}): ${[...items].slice(0, 25).join(" | ")}`);
  }

  /* ── THE DOCUMENT NUMBER, AND WHETHER IT IS ALREADY SPOKEN FOR ────────────
     `Primary Key Error` is AutoCount's own words for "something with this key
     is already here", and the report above could not say WHICH key. It printed
     the agent, the location, the creditor and the item codes — every FOREIGN
     key this chain has ever tripped over — and never once printed the document
     number the payload actually carries. So the one question a primary-key
     refusal asks ("what name did we ask the book to use?") was the one field
     you had to open a SQL console to see.

     Three facts, and they are three different questions:

       SENT AS      `payload -> body ->> DocNo` — the string AutoCount was
                    given. The ERP numbers its own documents on every type
                    (autocount-outbox.ts, "THE ERP NUMBERS ITS OWN DOCUMENTS"),
                    so this should equal doc_no exactly. If it ever differs,
                    something between the composer and the queue is rewriting
                    the number, and that is the finding.
       SENT BEFORE  another row for the SAME company + doc_type + doc_no that
                    reached `sent`. The queue is append-only and never deletes,
                    so a `sent` sibling is the ERP's OWN record that this number
                    has already been written into the account book — which makes
                    a second create of it a duplicate the book must refuse.
       ERP LINK     `linked_ac_docno` on the document itself. A create is only
                    enqueued when this is NULL (`enqueueSoCreate` returns early
                    otherwise), so a stuck create means the ERP believes the
                    document is NOT in the book. When that belief is wrong —
                    the column was cleared by hand, or a send landed and the
                    write-back never recorded it — the ERP will keep asking for
                    a number the book already holds, forever.

     Nothing here can see inside AED_HOUZS: this reads the ERP's Postgres and
     the account book is SQL Server on the office host. What it can do is say
     whether the ERP's OWN records already claim that number, which is the
     difference between a guess and a lead. */
  const names = await pg`
    SELECT o.id, o.doc_type, o.doc_no, o.op, o.status, o.attempts, o.created_at,
           o.payload -> 'body' ->> 'DocNo'              AS sent_doc_no,
           jsonb_exists(o.payload -> 'body', 'DocNo')   AS carries_doc_no,
           o.ac_doc_no,
           prior.n_sent,
           prior.sent_as
      FROM scm.autocount_outbox o
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n_sent,
               string_agg(DISTINCT coalesce(p.ac_doc_no, '(sent, no ac_doc_no recorded)'), ' | ') AS sent_as
          FROM scm.autocount_outbox p
         WHERE p.company_id = o.company_id
           AND p.doc_type   = o.doc_type
           AND p.doc_no     = o.doc_no
           AND p.status     = 'sent'
           AND p.id        <> o.id
      ) prior ON true
     WHERE o.status IN ('pending', 'failed')
     ORDER BY o.created_at DESC
     LIMIT 40`;

  if (names.length) {
    /* The ERP side of the same question, for exactly the documents above.
       Two tables because a sales order and a purchase order do not share a
       key column — `doc_no` on one, `po_number` on the other — and a UNION is
       one statement where two round trips would be two. */
    const soNos = names.filter((r) => r.doc_type === 'SO').map((r) => r.doc_no);
    const poNos = names.filter((r) => r.doc_type === 'PO').map((r) => r.doc_no);
    const links = await pg`
      SELECT 'SO' AS doc_type, h.doc_no AS doc_no, h.linked_ac_docno AS linked,
             h.created_at AS created
        FROM scm.mfg_sales_orders h
       WHERE h.doc_no = ANY(${soNos}::text[])
      UNION ALL
      SELECT 'PO' AS doc_type, p.po_number AS doc_no, p.linked_ac_docno AS linked,
             p.created_at AS created
        FROM scm.purchase_orders p
       WHERE p.po_number = ANY(${poNos}::text[])`;
    /* WHEN the ERP document itself was raised, which is the field that decides
       the REMEDY and not just the diagnosis. A number the book already holds is
       one problem with two completely different fixes:

         the ERP document is the ORIGINAL   its counterpart in the book IS this
                                            document. Nothing is wrong in the
                                            book; the ERP simply lost the link
                                            and is asking for a document it
                                            already has. The repair is to record
                                            the link, never to write again.
         the ERP document is NEWER          the ERP minted a number the book had
                                            already given to a DIFFERENT
                                            document. Recording the link would
                                            point this document at somebody
                                            else's, so the fix is a number, not
                                            a link.

       Both look identical from `Primary Key Error`, and picking the wrong one
       either duplicates a live accounting document or mislabels one. */
    const linkOf = new Map(links.map((r) => [`${r.doc_type}:${r.doc_no}`, r]));

    notice(
      `DOCUMENT NUMBER ON THE STUCK ROWS — ${names.length} row(s). ` +
        'A primary-key refusal is about a NAME, so this is the name we asked for.',
    );
    for (const r of names) {
      const key = `${r.doc_type}:${r.doc_no}`;
      const known = linkOf.has(key);
      const linked = linkOf.get(key)?.linked ?? null;
      const raised = linkOf.get(key)?.created ?? null;
      notice(
        `  - ${r.doc_type} ${r.doc_no} (${r.op}, ${r.status}, ${r.attempts} attempt(s)): ` +
          `sentAs=${r.carries_doc_no ? JSON.stringify(r.sent_doc_no) : 'KEY ABSENT — AutoCount auto-numbers'} ` +
          (r.carries_doc_no && r.sent_doc_no !== r.doc_no
            ? `DIFFERS FROM ERP doc_no ${JSON.stringify(r.doc_no)} `
            : '') +
          `erpLink=${known ? JSON.stringify(linked) : 'DOCUMENT NOT FOUND in the ERP table'} ` +
          (raised ? `erpRaised=${new Date(raised).toISOString().slice(0, 16)} ` : '') +
          `queued=${new Date(r.created_at).toISOString().slice(0, 16)} ` +
          `sentBefore=${r.n_sent ?? 0}` +
          (r.n_sent ? ` AS ${r.sent_as}` : ''),
      );
    }
    /* THE READING, spelled out, because the three fields above only mean
       something together and a reader at 11pm should not have to combine them. */
    for (const r of names) {
      const key = `${r.doc_type}:${r.doc_no}`;
      const linked = linkOf.get(key)?.linked ?? null;
      if ((r.n_sent ?? 0) > 0) {
        notice(
          `  !! ${r.doc_type} ${r.doc_no}: this queue has ALREADY sent this exact number ` +
            `(${r.n_sent} row(s), as ${r.sent_as}). Asking the book to create it again is a ` +
            'duplicate, and a duplicate is what a primary-key refusal looks like.',
        );
      }
      if (linkOf.has(key) && !linked) {
        notice(
          `  ?  ${r.doc_type} ${r.doc_no}: linked_ac_docno is NULL, so the ERP believes this ` +
            'document is NOT in the account book. If AutoCount is refusing the number, that ' +
            'belief is wrong and only the book can say so — see the AED_HOUZS query below.',
        );
      }
    }
    /* WHAT WOULD SETTLE IT, as a query someone with the book can run. This
       script cannot reach AED_HOUZS, and saying so with the exact statement is
       the honest form of "unknown" — it names what would answer the question
       instead of leaving a reader to invent one. */
    const soList = [...new Set(names.filter((r) => r.doc_type === 'SO').map((r) => r.doc_no))];
    const poList = [...new Set(names.filter((r) => r.doc_type === 'PO').map((r) => r.doc_no))];
    notice(
      'THIS SCRIPT CANNOT SEE INSIDE AED_HOUZS (that book is SQL Server on the office host). ' +
        'What settles a primary-key refusal is whether the book already holds the number:' +
        (soList.length ? `  SELECT DocNo, Cancelled FROM SO WHERE DocNo IN (${soList.map((d) => `'${d}'`).join(', ')});` : '') +
        (poList.length ? `  SELECT DocNo, Cancelled FROM PO WHERE DocNo IN (${poList.map((d) => `'${d}'`).join(', ')});` : ''),
    );
  }

} finally {
  await pg.end({ timeout: 5 });
}

/* ── THE VERDICT, and it runs AFTER the finally on purpose ────────────────────
   The report above is the whole point of the run and must reach the log whether
   or not the alarm fires. Exiting from inside the try would take the connection
   down mid-report; exiting here means the log is complete and the exit code is
   the only thing that changed. */
if (process.env.ALARM === '1') {
  const limitMin = Number(process.env.ALARM_PENDING_MINUTES ?? 60);
  const stalled = alarm.pending.filter((r) => r.ageS > limitMin * 60);
  const reasons = [];
  if (alarm.failedOutstanding > 0) {
    reasons.push(
      `${alarm.failedOutstanding} document(s) are in the ERP and NOT in AutoCount, ` +
        'with no retries left. Open AutoCount Sync and press Send again on each.',
    );
  }
  if (stalled.length) {
    const worst = stalled[0];
    reasons.push(
      `${stalled.length} document(s) have been queued longer than ${limitMin} minutes — ` +
        `oldest ${worst.docType} ${worst.docNo} (${worst.op}) waiting ${worst.age}. ` +
        'The AutoCount host is usually not answering; check that AcSyncService is running on it.',
    );
  }
  if (reasons.length) {
    /* ::error:: so the line is the one GitHub quotes in the failure e-mail —
       the e-mail IS the alarm, so the sentence a person reads first has to say
       what is wrong and what to do, not "a step failed". */
    for (const r of reasons) console.log(`::error::AutoCount sync: ${r}`);
    process.exitCode = 1;
  } else {
    notice('ALARM: nothing stuck. Silent pass.');
  }
}
