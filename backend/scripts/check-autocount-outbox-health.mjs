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

/* The reason strings the ERP writes when it declines to send. Each is produced
   by a named code path, so a bucket that grows tells you WHICH path. */
const SKIP_KINDS = [
  ["refused, nothing sent", "line identity missing — backfill linked_ac_dtlkey, then save again"],
  ["masters not opened", "an item or salesperson could not be opened in AutoCount"],
  ["no source document to transfer from", "raised with no parent — cannot exist in AutoCount at all"],
  ["AutoCount has no shape", "merged conversion (N sources -> 1 document) — must be worked by hand"],
];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [counts, oldest, failed, skipped] = await Promise.all([
    pg`SELECT status, count(*)::int AS n FROM scm.autocount_outbox GROUP BY status ORDER BY status`,
    pg`SELECT doc_type, doc_no, op, attempts,
              (now() - created_at) AS age
         FROM scm.autocount_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
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

  const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const total = counts.reduce((a, r) => a + r.n, 0);

  if (total === 0) {
    notice("QUEUE EMPTY — zero rows of any status.");
    notice(
      "That is not 'drained'. The table is append-only by design, so an empty " +
        "table means NOTHING HAS EVER BEEN ENQUEUED — which is the correct " +
        "state while scm.autocount_writeback is off.",
    );
  } else {
    notice(
      `queue: ${total} row(s) — ` +
        ["pending", "sent", "failed", "skipped"]
          .map((s) => `${s} ${by[s] ?? 0}`)
          .join(" / "),
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
    notice(`oldest PENDING: ${o.doc_type} ${o.doc_no} (${o.op}), waiting ${o.age}, ${o.attempts} attempt(s)`);
    notice(
      "A pending row is not an error by itself — it is only one if the age keeps " +
        "climbing. MAX_ATTEMPTS is 6 on a 5-minute cron, so a row dead-letters " +
        "after roughly 30 minutes of the service being unreachable.",
    );
  } else {
    notice("oldest PENDING: none");
  }

  /* SKIPPED, classified. Unclassified rows are printed rather than counted
     away: a reason this script does not recognise is a code path that grew a
     new refusal, and rolling it into 'other' is how it stays invisible. */
  if ((by.skipped ?? 0) > 0) {
    const seen = new Set();
    for (const [needle, meaning] of SKIP_KINDS) {
      const hits = skipped.filter((r) => r.last_error.includes(needle));
      hits.forEach((r) => seen.add(r.doc_no + r.op));
      if (hits.length) notice(`  skipped ${hits.length}: ${meaning}`);
    }
    const rest = skipped.filter((r) => !seen.has(r.doc_no + r.op));
    for (const r of rest) {
      notice(`  skipped (UNRECOGNISED reason): ${r.doc_type} ${r.doc_no} (${r.op}): ${r.last_error.slice(0, 200)}`);
    }
  } else {
    notice("SKIPPED: 0");
  }
} finally {
  await pg.end({ timeout: 5 });
}
