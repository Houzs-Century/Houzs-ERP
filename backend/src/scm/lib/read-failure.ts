// ----------------------------------------------------------------------------
// read-failure — what a failed SCM read SAYS, to the operator and to the log.
//
// WHY THIS EXISTS, in one production trace. On 2026-08-17 GET
// /api/scm/delivery-planning answered `{"error":"Something went wrong. Please
// try again."}` for every filter in BOTH companies — index.ts's humanizeError
// final fallback, which is what a plain `throw new Error(...)` reaching the
// global handler produces. Locating it needed a `wrangler tail` against the live
// Worker, and the line it printed was:
//
//     [onError] Error: delivered-sum read failed:
//
// Nothing after the colon. The template was `${err.message ?? String(err)}`, and
// the driver had handed back an error whose `message` was the EMPTY STRING — so
// the one field the message interpolated was the one field that was blank, and
// `??` does not fire on '' . Two separate failures of nerve, both fixed here:
//
//   1. THE THROW SAID NOTHING. supabase-js errors carry `code` / `details` /
//      `hint` as well as `message`, and a gateway rejection (an over-long
//      request URI, say) can arrive with none of them set — so describeReadError
//      falls back to dumping the object rather than resolving to ''. A diagnostic
//      string that can be empty is not a diagnostic.
//
//   2. THE ROUTE SAID NOTHING EITHER. Every sibling SCM list answers
//      `{error:'load_failed', reason}`; this one throw escaped its handler
//      instead, and the callers that do NOT catch it (the Sales Order list among
//      them) had no way to say which read died. readFailureError wraps the throw
//      in an HTTPException carrying that exact body, so an UNCAUGHT one now
//      lands as `{error:'load_failed', stage, reason}` too — index.ts passes an
//      HTTPException's own response through untouched. Callers that DO catch use
//      readFailure() and get the same body.
//
// THE SPLIT IS DELIBERATE: the RICH detail (driver text, codes, list sizes) goes
// to console.error and nowhere else; the operator gets a stage code they can
// quote and a plain sentence. Staff must never be shown Postgres strings — that
// is what humanizeError exists for — and we must never again be shown nothing.
// ----------------------------------------------------------------------------

import { HTTPException } from 'hono/http-exception';

/** Best-effort JSON of an unknown throwable, bounded so a log line stays a log
 *  line. Never throws, never returns '' — an unserialisable value still names
 *  its type. */
function safeJson(err: unknown): string {
  try {
    const s = JSON.stringify(err, Object.getOwnPropertyNames(Object(err)));
    if (s && s !== '{}') return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch { /* circular / exotic — fall through */ }
  return `<${typeof err}> ${String(err)}`;
}

/**
 * Everything KNOWN about a failed read, as one line for the log.
 *
 * `ctx` is what the CALLER knows and the driver does not: which table, which
 * filter, how many ids went into it. That is the half that turns "Bad Request"
 * into "we asked for 13,900 ids in one `.in()`", and it is why this takes a
 * context argument rather than just an error.
 *
 * Guaranteed non-empty. When `message` is blank — the case that produced a bare
 * colon in production — the raw object is dumped alongside, so the next reader
 * gets the whole thing instead of a punctuation mark.
 */
export function describeReadError(
  err: unknown,
  ctx: Readonly<Record<string, string | number>> = {},
): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const field = (k: string): string | null => {
    const v = e[k];
    return typeof v === 'string' && v.trim() !== '' ? `${k}=${v.trim()}` : null;
  };
  const parts: string[] = [];
  for (const k of ['message', 'code', 'details', 'hint']) {
    const f = field(k);
    if (f) parts.push(f);
  }
  // No usable message is itself the finding — say so, and hand over the object.
  if (!field('message')) parts.push('message=<empty>', `raw=${safeJson(err)}`);
  for (const [k, v] of Object.entries(ctx)) parts.push(`${k}=${v}`);
  return parts.join(' ');
}

export type ReadFailureBody = { error: 'load_failed'; stage: string; reason: string };

/** What each stage code means to a human. A stage with no entry still answers —
 *  the CODE is the part support needs, the phrase is a courtesy. */
const STAGE_LABEL: Record<string, string | undefined> = {
  warehouses: 'the warehouse list',
  sales_orders: 'the sales orders',
  delivered_sum: 'delivery progress',
};

/**
 * The 500 body for a read that failed, and the log line carrying the real cause.
 *
 * Kept well under 200 characters: the SCM client discards a longer server
 * message and shows a generic wall instead, which is the failure mode this
 * module exists to end.
 */
export function readFailure(
  stage: string,
  err: unknown,
  ctx: Readonly<Record<string, string | number>> = {},
): ReadFailureBody {
  // eslint-disable-next-line no-console
  console.error(`[scm] ${stage} read failed: ${describeReadError(err, ctx)}`);
  return {
    error: 'load_failed',
    stage,
    reason: `Could not load ${STAGE_LABEL[stage] ?? stage}. Please try again — if it keeps failing, report code "${stage}".`,
  };
}

/**
 * The same failure, as something an ENGINE can throw when it has no `c` to
 * answer with. An uncaught one still reaches the client as the body above,
 * because index.ts hands an HTTPException's own response straight through.
 *
 * `message` is the operator-safe sentence on purpose — mrp.ts's catch returns
 * `e.message` to the caller, so anything richer here would leak driver text to
 * staff. The rich detail is already in the log by the time this returns.
 */
export function readFailureError(
  stage: string,
  err: unknown,
  ctx: Readonly<Record<string, string | number>> = {},
): HTTPException {
  const body = readFailure(stage, err, ctx);
  return new HTTPException(500, {
    message: body.reason,
    cause: err,
    res: new Response(JSON.stringify(body), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

/**
 * A read whose failure DEGRADES the page rather than stopping it (a missing
 * balance, a missing crew name). It stays best-effort — but it stops being
 * invisible, because "this read returned nothing" and "this read failed" render
 * identically and only one of them is a fact about the data.
 */
export function noteDegradedRead(stage: string, err: unknown): void {
  if (!err) return;
  // eslint-disable-next-line no-console
  console.error(`[scm] ${stage} read failed; page degraded: ${describeReadError(err)}`);
}
