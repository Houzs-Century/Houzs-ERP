
import type { Env } from '../scm/env';
import { acServiceConfig } from './autocount-writeback';

/** The read-only routes. Adding one here must NOT mean adding an AcOp. */
export const AC_READ_ROUTE = {
  last_errors: '/last-errors',
  doc_read: '/doc-read',
  /* What columns a document table actually HAS. One SELECT on sys.columns,
     names only. It exists to settle whether a document DETAIL can carry a
     user-defined column — which decides whether line identity can be OURS
     instead of AutoCount's (owner, 2026-08-31). */
  table_columns: '/table-columns',
  /* EVERY document's line count and ordered item codes, in ONE SELECT. Asking
     `/doc-read` per document is ~2,700 round trips through the tunnel, which no
     single Worker request survives; this is what makes a whole-population sweep
     possible at all (owner: 「之后有问题吗？我不要每次都来 fix 啊」). */
  line_fingerprints: '/line-fingerprints',
  /* The ONE column the inbound pull cannot see. AutoCount keeps a document's
     delivery date on the LINE (SODTL/DODTL.DeliveryDate) and the read
     middleware serves a nine-column HEADER projection, so a date changed in
     the book after import never reached us while our own edits flowed the
     other way. Windowed on the delivery date itself. docs/bugs/0810. */
  delivery_dates: '/delivery-dates',
} as const;

export type AcReadOp = keyof typeof AC_READ_ROUTE;

export interface AcReadResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Ask the host one read-only question.
 *
 * Writes nothing, opens no SDK session, and takes no outbox row — so it has no
 * retry policy and no attempts. A failure here is reported and dropped; nothing
 * queues, because there is nothing to deliver.
 */
export async function callAcRead(
  env: Env,
  op: AcReadOp,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<AcReadResult> {
  const cfg = acServiceConfig(env);
  if (!cfg) {
    return { ok: false, status: 0, body: null, error: 'AC_SYNC_URL is not configured' };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}${AC_READ_ROUTE[op]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.key ? { 'X-API-KEY': cfg.key } : {}),
      },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (e) {
    return {
      ok: false, status: 0, body: null,
      error: `the AutoCount host could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = null; }

  if (res.ok && body && body.ok !== false) {
    return { ok: true, status: res.status, body, error: null };
  }
  /* THE SAME DISTINCTION THE WRITE PATH LEARNED THE HARD WAY (#2686): a gateway
     status with a NON-JSON body is the tunnel answering for a host that is not
     running, and saying "AutoCount refused" about it sends a reader to look at
     the account book for a stopped Windows service. */
  const GATEWAY = new Set([502, 503, 504]);
  if (body === null && GATEWAY.has(res.status)) {
    return {
      ok: false, status: res.status, body: null,
      error: `the AutoCount host did not answer (HTTP ${res.status}) — the request never reached it, `
        + 'so this says nothing about the account book. Check that AcSyncService is running on the host.',
    };
  }
  return {
    ok: false,
    status: res.status,
    body,
    error: String((body?.error as string | undefined) ?? (text.slice(0, 300) || `HTTP ${res.status}`)),
  };
}
