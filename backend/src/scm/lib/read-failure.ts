// global handler produces. Locating it needed a `wrangler tail` against the live

import { HTTPException } from 'hono/http-exception';

function safeJson(err: unknown): string {
  try {
    const s = JSON.stringify(err, Object.getOwnPropertyNames(Object(err)));
    if (s && s !== '{}') return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch { }
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
  if (!field('message')) parts.push('message=<empty>', `raw=${safeJson(err)}`);
  for (const [k, v] of Object.entries(ctx)) parts.push(`${k}=${v}`);
  return parts.join(' ');
}

export type ReadFailureBody = { error: 'load_failed'; stage: string; reason: string };

const STAGE_LABEL: Record<string, string | undefined> = {
  warehouses: 'the warehouse list',
  sales_orders: 'the sales orders',
  delivered_sum: 'delivery progress',
  so_lines: 'the order lines',
  so_payments: 'the payments',
  so_amendments: 'the amendment requests',
  so_line_deliveries: 'what each line has delivered',
  so_lifecycle: 'the order status',
  do_lines: 'the delivery order lines',
  do_crew: 'the delivery crew',
  do_line_consumed: 'what this line has invoiced or returned',
  grn_lines: 'the receipt lines',
  grn_po_lines: 'the purchase order lines',
  grn_linked_invoices: 'the invoices for this receipt',
  po_lines: 'the purchase order lines',
  po_line_receipts: 'what each line has received',
  po_picker_suppliers: 'the main supplier of each item',
  document_flow: 'the document flow',
  bank_open_lines: 'how much of each statement is still open',
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
