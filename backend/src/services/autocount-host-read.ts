/* ----------------------------------------------------------------------------
   autocount-host-read — the READ-ONLY routes AcSyncService already exposes, and
   which nothing in this ERP has ever called.

   WHY THIS FILE EXISTS. AcSyncService serves four read-only routes —
   `/last-errors`, `/doc-read`, `/further-description`, `/picture-census` — and
   on 2026-08-25 a grep proved every one of them was dead code from the ERP's
   point of view: the only file in the repo naming `/last-errors` was the C#
   that serves it.

   That is not a tidiness problem, it is what a diagnosis costs. `HC-DO-2608-006`
   failed with the contentless `Invalid transfer item.` The one line that settles
   it — `target debtor before transfer = [...]`, written by the service itself —
   sat in `C:\Temp\ac-sync-service.log` on the office machine. Reading it meant a
   TeamViewer session, Notepad, and dragging a scrollbar through a 377 KB file,
   and it still was not read. The service had been willing to serve that line
   over HTTP the whole time.

   A SEPARATE CALLER, NOT A NEW `AcOp`. `callAcService` is keyed by `AcOp`, and
   every `AcOp` is a thing an outbox ROW can be — a document operation with a
   status, attempts and a retry policy. `/last-errors` is none of those. Adding
   it to that union would put a non-document into a vocabulary whose whole
   discipline is that each member names a document's journey, and the queue's
   own code would then have to carry "except this one" everywhere it switches on
   op. One column serving two meanings is exactly the defect the owner named on
   2026-08-25 about `supplier_material_bindings.supplier_sku`; this is the same
   shape and it is cheaper to refuse here than to unpick later.
   -------------------------------------------------------------------------- */

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
} as const;

export type AcReadOp = keyof typeof AC_READ_ROUTE;

export interface AcReadResult {
  ok: boolean;
  status: number;
  /** The service's own JSON, verbatim, or null when it did not answer JSON. */
  body: Record<string, unknown> | null;
  /** One sentence a person can act on. Null when ok. */
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
