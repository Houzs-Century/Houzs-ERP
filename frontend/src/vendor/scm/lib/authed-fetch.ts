
import { serviceConfirm } from './dialog-service';
import { describeRefusal } from './refusal-detail';
import {
  ZERO_COST_RECEIPT_ERROR,
  parseZeroCostRefusal,
  zeroCostRefusalText,
} from './zero-cost-refusal';
import { readAuthToken, readAuthPass } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';
import { abortableDelay, combineAbortSignals } from '../../../lib/abort';
import { reportServerFailure, reportAccessDenied, reportSlowRequest, reportTimedOutRequest } from '../../../lib/errorReporter';

const SLOW_FETCH_MS = 800;

/** Doc numbers (HC-SO-2609-004, PO-2607-001) are ids, so one endpoint stays one telemetry signature. */
export const scmTelemetryPath = (path: string): string =>
  path.replace(/\/[A-Z]+(?:-[A-Z]+)*-\d{4}-\d+(?:-[A-Z0-9]+)*(?=[/?#]|$)/gi, '/:id');

export const API_URL =
  (import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) +
  '/api/scm';

/* The bill readers — a supplier bill, a supplier credit note, a payment
   request's bill — each hand ONE paper to the AI reader, which can take past
   30 s on a long bill (owner 2026-10-05: the pile's "That took too long").
   They get the scan wait, and since they WRITE NOTHING a timeout says so
   instead of warning of a duplicate save. */
export const BILL_READER_PATH = /\/payment-vouchers\/extract(\/enqueue)?$|\/credit-notes\/scan(\/enqueue)?$|\/payment-requests\/read-bill(\/enqueue)?$|\/stock-takes\/[^/]+\/read-sheet$/;
/* A document's file upload (POST …/files, …/official-doc) carries the whole
   file as base64 in one body — up to 27 MB for the 20 MB cap — which a slow
   office uplink does not finish in 30 s (owner 2026-10-15: attach 不到 pdf). */
export const FILE_UPLOAD_PATH = /\/files$|\/official-doc$/;
function timeoutSignal(path: string): AbortSignal | undefined {
  const ms = /\/scan-/.test(path) || BILL_READER_PATH.test(path) || FILE_UPLOAD_PATH.test(path) ? 120_000 : 30_000;
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

/** Keep caller cancellation and the request deadline active together. */
export const IN_FLIGHT_POLL_MS = 1000;
export const IN_FLIGHT_MAX_WAIT_MS = 60_000;

export async function isIdempotencyInFlight(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const text = await res.clone().text().catch(() => '');
  return text.includes('"idempotency_in_flight"');
}

/** fetchWithTimeout, riding out the server's idempotency_in_flight answer for a keyed mutation. */
export async function fetchRidingInFlight(
  send: () => Promise<Response>,
  hasIdemKey: boolean,
  signal: AbortSignal | null | undefined,
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void> = (ms, sig) => abortableDelay(ms, sig ?? undefined),
): Promise<Response> {
  let res = await send();
  if (!hasIdemKey) return res;
  for (let waited = 0; waited < IN_FLIGHT_MAX_WAIT_MS && (await isIdempotencyInFlight(res)); waited += IN_FLIGHT_POLL_MS) {
    await sleep(IN_FLIGHT_POLL_MS, signal);
    res = await send();
  }
  return res;
}

async function fetchWithTimeout(url: string, init: RequestInit, path: string): Promise<Response> {
  const callerSignal = init.signal;
  const deadlineSignal = timeoutSignal(path);
  try {
    return await correlatedFetch(url, {
      ...init,
      signal: combineAbortSignals(callerSignal, deadlineSignal),
    });
  } catch (e) {
    const requestId = requestIdFromError(e);
    /* Mark an error TRANSIENT so authedFetch's loop replays it — for a GET, or a
       mutation whose Idempotency-Key makes a replay safe (owner 2026-09-22: a save
       must ride out a slow spell, not fail at the first stall). */
    const markTransient = <E>(err: E): E => { (err as E & { transient?: boolean }).transient = true; return err; };
    if (callerSignal?.aborted) throw e;
    if (deadlineSignal?.aborted && e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      /* A timed-out READ is just a read — "try again" is sound advice. A timed-out
         WRITE is not: aborting the fetch does not abort the Worker, so the save
         may already have committed. What we may honestly tell the operator turns
         on whether this request carried an Idempotency-Key:
           • with one, a retry REPLAYS the first response rather than minting a
             second document, so "try again" is safe;
           • without one, "try again" is how a duplicate sales order gets raised,
             so we say CHECK first. Admitting the uncertainty beats a confident
             instruction that creates a duplicate.
         Either way it fails LOUDLY — never a spinner the operator walks away
         from believing it saved (owner ruling 2026-07-19). */
      const method = String(init.method ?? 'GET').toUpperCase();
      try { reportTimedOutRequest(method, scmTelemetryPath(path)); } catch { }
      if (method !== 'GET' && BILL_READER_PATH.test(path)) {
        throw correlateError(new Error('Reading took too long — nothing was saved. Please read it again.'), requestId);
      }
      if (method !== 'GET') {
        const hasIdemKey = Boolean(
          (init.headers as Record<string, string> | undefined)?.['Idempotency-Key'],
        );
        throw markTransient(correlateError(new Error(
          hasIdemKey
            ? "That took too long, so we couldn't confirm whether it saved. Please retry this same action once; its safety key will check the original request instead of creating a duplicate."
            : "That took too long and we couldn't confirm whether it saved. Please refresh and check before trying again — saving twice may create a duplicate.",
        ), requestId));
      }
      throw markTransient(correlateError(new Error('The request took too long — please check your connection and try again.'), requestId));
    }
    if (e instanceof TypeError) {
      throw markTransient(correlateError(new Error('Network error — please check your connection and try again.'), requestId));
    }
    throw e;
  }
}

/* The sentence a failed write's notice ends on (HC-0167). "Nothing was changed"
   is only true when the server ANSWERED with a refusal. A timeout, a dropped
   connection or a gateway 502/504 leaves the Worker running, so the write may
   still commit after the operator was told it did not — and they click again.
   The 30-second timeout's own message already says to refresh and check, so it
   gets no tail; the other unknown outcomes get that advice here. */
export function failedWriteTail(e: unknown, unchanged: string): string {
  const err = e as { transient?: unknown; status?: unknown; message?: unknown } | null;
  const gateway = err?.status === 502 || err?.status === 504;
  if (!gateway && err?.transient !== true) return ` ${unchanged}`;
  if (/whether it saved/.test(String(err.message ?? ''))) return '';
  return ' Refresh this page to see whether it went through before trying again.';
}

type DropshipOffender = { itemCode: string; soItemId: string | null; poNumber: string | null; eta: string | null };
async function confirmDropship(raw: string): Promise<boolean> {
  try {
    const jsonStart = raw.indexOf('{');
    const body = JSON.parse(raw.slice(jsonStart)) as { dropship?: DropshipOffender[] };
    const offenders = body.dropship ?? [];
    const byPo = new Map<string, { eta: string | null; codes: Set<string> }>();
    for (const o of offenders) {
      if (!o.poNumber) continue;
      const g = byPo.get(o.poNumber) ?? { eta: o.eta, codes: new Set<string>() };
      if (o.itemCode) g.codes.add(o.itemCode);
      byPo.set(o.poNumber, g);
    }
    const poLines = [...byPo.entries()].map(([po, g]) => {
      const eta = g.eta ? `ETA ${g.eta}` : 'ETA not set';
      return `• Incoming PO ${po} (${eta})\n   Sofa: ${[...g.codes].join(', ')}`;
    }).join('\n\n');
    const codes = [...new Set(offenders.map((o) => o.itemCode).filter(Boolean))].join(', ');
    return await serviceConfirm({
      title: 'Ship as drop-ship?',
      body:
        `No batch has been received yet for this sofa set — the supplier ships ` +
        `it direct to the customer.\n\n${poLines}\n\n` +
        `Stock will go negative against ${byPo.size === 1 ? `batch ${[...byPo.keys()][0]}` : 'the incoming batches'}. ` +
        `It nets out and the batch number stamps onto this Delivery Order when ` +
        `the Goods Received Note arrives.\n\nAffected: ${codes}`,
      confirmLabel: 'Confirm drop-ship',
      danger: true,
    });
  } catch {
    return false;
  }
}

async function confirmNotReady(raw: string): Promise<boolean> {
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{'))) as {
      lines?: Array<{ docNo: string; itemCode: string; reason: string }>;
    };
    const lines = (body.lines ?? [])
      .map((l) => `• ${l.itemCode} (${l.docNo})\n   ${l.reason}`)
      .join('\n\n');
    return await serviceConfirm({
      title: 'Item Not Ready',
      body: `${lines}\n\nGo back and untick these lines to deliver them on a later Delivery Order, or deliver them now anyway.`,
      confirmLabel: 'Deliver anyway',
      danger: true,
    });
  } catch {
    return false;
  }
}

export function soHasPoMessage(raw: string): string {
  const body = JSON.parse(raw.slice(raw.indexOf('{'))) as {
    poNumbers?: string[];
    lines?: Array<{ itemCode: string | null; soDocNo: string | null; poNumber: string; assignedTo?: string[] | null; coversThisSo?: boolean | null }>;
    assignmentError?: string | null;
  };
  /* Each PO says where MRP is sending it NOW (owner 2026-11-19): a PO MRP has given
     to another order is not this order's any more - the line is short again. */
  const byLine = new Map<string, string[]>();
  for (const l of body.lines ?? []) {
    const k = [l.itemCode, l.soDocNo && `(${l.soDocNo})`].filter(Boolean).join(' ') || 'A line';
    const where = l.assignedTo == null
      ? ''
      : l.coversThisSo
        ? ' - still covering this order'
        : l.assignedTo.length > 0
          ? ` - MRP has given it to ${l.assignedTo.join(', ')}`
          : ' - MRP has not assigned it to any order';
    byLine.set(k, [...(byLine.get(k) ?? []), `${l.poNumber}${where}`]);
  }
  const lines = [...byLine.entries()].map(([k, pos]) => `• ${k}\n${pos.map((p) => `   raised on ${p}`).join('\n')}`).join('\n\n');
  const all = body.lines ?? [];
  const known = all.length > 0 && all.every((l) => l.assignedTo != null);
  const stillHere = all.some((l) => l.coversThisSo === true);
  const foot = !known
    ? (body.assignmentError ? `\n\nCould not read where MRP is sending these POs (${body.assignmentError}).` : '')
    : stillHere
      ? '\n\nA PO above is still covering this order - another PO may order the same goods twice.'
      : '\n\nEvery PO above has been given to another order by MRP, so this order is short again.';
  return `This Sales Order was already raised on PO(s): ${(body.poNumbers ?? []).join(', ')}.\n\n${lines}${foot}\n\nContinue to generate another PO for these lines?`;
}
async function confirmSoHasPo(raw: string): Promise<boolean> {
  try {
    return await serviceConfirm({
      title: 'PO already generated for this Sales Order',
      body: soHasPoMessage(raw),
      confirmLabel: 'Continue',
      danger: true,
    });
  } catch {
    return false;
  }
}

function transferShortageLines(raw: string): string {
  const body = JSON.parse(raw.slice(raw.indexOf('{'))) as {
    shortages?: Array<{ itemCode: string; variantKey: string; requested: number; available: number }>;
  };
  return (body.shortages ?? []).map((s) =>
    `• ${s.itemCode}${s.variantKey ? ` (${s.variantKey})` : ''}\n   Transfer ${s.requested}, only ${s.available} at the source warehouse (short ${s.requested - s.available})`,
  ).join('\n\n');
}

/** The refusal shown to someone who may not post a stock transfer short of stock. */
export function transferShortStockRefusal(raw: string): string {
  let lines = '';
  try { lines = transferShortageLines(raw); } catch { lines = ''; }
  return `Not enough stock at the source warehouse, so the stock transfer was not posted.${lines ? `\n\n${lines}` : ''}\n\n`
    + `Lower the quantity, or ask someone with the "Post a stock transfer short of stock" permission to post it.`;
}

async function confirmTransferShortStock(raw: string): Promise<boolean> {
  try {
    return await serviceConfirm({
      title: 'Stock not enough at the source warehouse',
      body: `${transferShortageLines(raw)}\n\nPost anyway? (Stock at the source warehouse will go negative, and the audit log records the override.)`,
      confirmLabel: 'Post anyway',
      danger: true,
    });
  } catch {
    return false;
  }
}

async function confirmShortStock(raw: string): Promise<boolean> {
  try {
    const jsonStart = raw.indexOf('{');
    const body = JSON.parse(raw.slice(jsonStart)) as {
      shortages?: Array<{
        itemCode: string; warehouseName: string | null;
        needed: number; available: number; short: number;
        alternatives?: Array<{ warehouseCode: string | null; warehouseName: string | null; available: number }>;
      }>;
      bindings?: Array<{ itemCode: string; poNumber: string; eta: string | null }>;
    };
    const lines = (body.shortages ?? []).map((s) => {
      const alts = (s.alternatives ?? []).slice(0, 3)
        .map((a) => `${a.warehouseCode ?? a.warehouseName ?? '?'} (${a.available})`)
        .join(', ');
      const altHint = alts ? `\n   Other warehouses: ${alts}` : '';
      return `• ${s.itemCode}\n   At ${s.warehouseName ?? 'this warehouse'}: need ${s.needed}, available ${s.available} (short ${s.short})${altHint}`;
    }).join('\n\n');
    const byPo = new Map<string, { eta: string | null; codes: Set<string> }>();
    for (const b of body.bindings ?? []) {
      const g = byPo.get(b.poNumber) ?? { eta: b.eta, codes: new Set<string>() };
      if (b.itemCode) g.codes.add(b.itemCode);
      byPo.set(b.poNumber, g);
    }
    const bindNote = byPo.size === 0 ? '' :
      `\n\nThese lines are already on order and will be booked against the incoming purchase order:\n\n`
      + [...byPo.entries()].map(([po, g]) => {
        const eta = g.eta ? `ETA ${g.eta}` : 'ETA not set';
        return `• PO ${po} (${eta})\n   ${[...g.codes].join(', ')}`;
      }).join('\n\n')
      + `\n\nStock goes negative against that batch and nets out — with the real cost —`
      + ` when the Goods Received Note arrives.`;
    return await serviceConfirm({
      title: 'Stock not enough at the selected warehouse',
      body: `${lines}${bindNote}\n\nShip anyway? (Stock will go negative.)`,
      confirmLabel: 'Ship anyway',
      danger: true,
    });
  } catch {
    return false;
  }
}

export async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readAuthToken();
  const pass = readAuthPass();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  const callerHeaders = (init?.headers ?? {}) as Record<string, string>;
  const callerPinnedCompany = Object.keys(callerHeaders).some((k) => k.toLowerCase() === 'x-company-id');
  const headers = {
    ...callerHeaders,
    authorization: `Bearer ${token}`,
    ...(pass ? { 'x-session-pass': pass } : {}),
    ...(callerPinnedCompany ? {} : companyHeader()),
    ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}),
  };
  const isGet = !init?.method || String(init.method).toUpperCase() === 'GET';
  /* A mutation that carries an Idempotency-Key is safe to REPLAY: the server
     returns the original outcome instead of minting a second document. That is what
     lets a transient gateway timeout (502/504) or a dropped connection on a SAVE be
     ridden out below, exactly like a GET (owner 2026-09-22, "改单 saving 拿很久" +
     504). Every SO save / payment / convert path already sends one. */
  const hasIdemKey = Boolean((headers as Record<string, string>)['Idempotency-Key']);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- init is an optional parameter
  const abortSignal = init?.signal;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      const startedAt = performance.now();
      res = await fetchRidingInFlight(() => fetchWithTimeout(`${API_URL}${path}`, { ...init, headers }, path), hasIdemKey, abortSignal);
      /* HC-0002: the SO / DO screens all read through here, not api/client.ts,
         so without this the slow-request baseline never saw the slowest pages. */
      const ms = Math.round(performance.now() - startedAt);
      if (ms >= SLOW_FETCH_MS) {
        const m = String(init?.method ?? 'GET').toUpperCase();
        console.warn(`[perf] slow ${m} /api/scm${path} - ${ms}ms id=${requestIdFromResponse(res)}`);
        try { reportSlowRequest(m, scmTelemetryPath(path), ms); } catch { }
      }
    } catch (e) {
      if (init?.signal?.aborted) throw e;
      if (isGet && attempt < 4) { await abortableDelay(600 + attempt * 1200, init?.signal); continue; }
      const transientThrow = typeof e === 'object' && e !== null && (e as { transient?: unknown }).transient === true;
      if (!isGet && hasIdemKey && attempt < 4 && transientThrow) {
        await abortableDelay(600 + attempt * 1200, abortSignal); continue;
      }
      throw e;
    }
    if (res.status === 503 && isGet && attempt < 4) { await abortableDelay(600 + attempt * 1200, init?.signal); continue; }
    if (res.status === 503 && !isGet && attempt < 4) {
      const warmText = await res.clone().text().catch(() => '');
      if (/briefly unavailable|warming up|try again in a moment/i.test(warmText)) {
        await abortableDelay(600 + attempt * 1200, init?.signal); continue;
      }
    }
    /* A 502/504 is a transient GATEWAY timeout — a busy Worker or a cold Hyperdrive
       pool that answered late (the owner's "saving 拿很久" then 504). A GET is always
       safe to replay; a mutation is safe only with an Idempotency-Key, which makes
       the server return the original outcome, never a second document. */
    if ((res.status === 502 || res.status === 504) && (isGet || hasIdemKey) && attempt < 4) {
      await abortableDelay(600 + attempt * 1200, abortSignal); continue;
    }
    break;
  }

  if (res.status === 409 && typeof init?.body === 'string') {
    let mergedBody: Record<string, unknown> | null = null;
    try { mergedBody = JSON.parse(init.body) as Record<string, unknown>; } catch { mergedBody = null; }
    for (let guard = 0; mergedBody && guard < 4 && res.status === 409; guard++) {
      const text = await consumeCorrelated(res, () => res.clone().text());
      if (text.includes('"items_not_ready"') && mergedBody.confirmNotReady !== true) {
        if (!(await confirmNotReady(text))) {
          throw correlateError(
            new Error('Some lines are not ready, so the delivery order was not created or confirmed. Nothing has changed; deliver them on a later Delivery Order, or answer Deliver anyway.'),
            requestIdFromResponse(res),
          );
        }
        mergedBody = { ...mergedBody, confirmNotReady: true };
      } else if (text.includes('"so_has_po"') && mergedBody.confirmDuplicatePo !== true) {
        if (!(await confirmSoHasPo(text))) {
          throw correlateError(
            new Error('No purchase order was generated. Nothing has changed.'),
            requestIdFromResponse(res),
          );
        }
        mergedBody = { ...mergedBody, confirmDuplicatePo: true };
      } else if (text.includes('"insufficient_stock"') && text.includes('"canOverride":true') && mergedBody.allowShortStock !== true) {
        if (!(await confirmTransferShortStock(text))) {
          throw correlateError(
            new Error('Not enough stock at the source warehouse, so the stock transfer was not posted. Nothing has changed.'),
            requestIdFromResponse(res),
          );
        }
        mergedBody = { ...mergedBody, allowShortStock: true };
      } else if (text.includes('"short_stock"') && mergedBody.confirmShortStock !== true) {
        if (mergedBody.dropShip !== true && !(await confirmShortStock(text))) break;
        mergedBody = { ...mergedBody, confirmShortStock: true };
      } else if (
        text.includes('"sofa_no_batch"') && text.includes('"canDropship":true') &&
        mergedBody.dropShip !== true
      ) {
        if (mergedBody.confirmShortStock === true) {
          mergedBody = { ...mergedBody, dropShip: true };
          res = await fetchWithTimeout(`${API_URL}${path}`, { ...init, headers, body: JSON.stringify(mergedBody) }, path);
          continue;
        }
        if (!(await confirmDropship(text))) {
          throw correlateError(
            new Error('Drop-ship not confirmed, so nothing was saved. Nothing has changed.'),
            requestIdFromResponse(res),
          );
        }
        mergedBody = { ...mergedBody, dropShip: true };
      } else {
        break;
      }
      res = await fetchWithTimeout(`${API_URL}${path}`, { ...init, headers, body: JSON.stringify(mergedBody) }, path);
    }
  }

  if (res.status === 409) {
    const text = await consumeCorrelated(res, () => res.clone().text());
    if (text.includes('"insufficient_stock"') && text.includes('"canOverride":false')) {
      throw correlateError(new Error(transferShortStockRefusal(text)), requestIdFromResponse(res));
    }
    if (text.includes('"sofa_no_batch"')) {
      let msg = "This sofa set can't ship yet — no single production batch on hand covers the whole set. Wait until one complete batch is received.";
      try { const b = JSON.parse(text) as { message?: string }; if (b?.message) msg = b.message; } catch { }
      throw correlateError(new Error(msg), requestIdFromResponse(res));
    }
    if (text.includes(`"${ZERO_COST_RECEIPT_ERROR}"`)) {
      const zeroCost = new Error(
        zeroCostRefusalText(parseZeroCostRefusal(text)),
      ) as Error & { status?: number; body?: string };
      zeroCost.status = res.status;
      zeroCost.body = text;
      throw correlateError(zeroCost, requestIdFromResponse(res));
    }
    if (text.includes('"sofa_partial_set"')) {
      let msg = "A sofa set must ship whole from one batch — this delivery leaves part of the set behind. Include the rest of the set, or ship none of it.";
      try { const b = JSON.parse(text) as { message?: string }; if (b?.message) msg = b.message; } catch { }
      throw correlateError(new Error(msg), requestIdFromResponse(res));
    }
    /* One PO IS one batch number (owner, 2026-07-31), so a sofa set that resolves
       two different POs would ship stamped with two batch numbers — a split dye
       lot. There is no "ship anyway" that makes that correct, so this is a hard
       stop like the two above: surface the server's message, which names each
       module and the PO it resolved. */
    if (text.includes('"sofa_set_po_split"')) {
      let msg = "A sofa set is one dye lot, so it must ship against one purchase order — its modules resolve different ones. Point them at the same PO, or ship none of it.";
      try { const b = JSON.parse(text) as { message?: string }; if (b?.message) msg = b.message; } catch { }
      throw correlateError(new Error(msg), requestIdFromResponse(res));
    }
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { }
    /* REPORT IT. reportServerFailure and reportAccessDenied have existed in
       errorReporter.ts since they were written and were called from NOWHERE — a
       grep across the whole frontend returns only their definitions. So every
       API 5xx has been invisible: the operator saw "The system hit a problem",
       the screen carried on, and nothing anywhere recorded that it happened.
       Owner, 2026-08-05, holding a screenshot of exactly that message on Edit
       Sales Order: "这是什么意思呢？是什么问题呢？" — and the honest answer was
       that the system had not kept one.
       Best-effort and non-blocking: a reporter that throws must never turn a
       500 into two failures. */
    try {
      const m = String(init?.method ?? 'GET').toUpperCase();
      if (res.status >= 500) reportServerFailure(m, scmTelemetryPath(path), res.status);
      else if (res.status === 403) reportAccessDenied(m, scmTelemetryPath(path));
    } catch { }
    // Plain-language message for the operator (Wei Siang 2026-06-08: every error
    // shown must be 白话文 — no HTTP codes, no raw JSON, no DB internals). The
    // raw status/body are preserved on the error object for logging / Sentry.
    const err = new Error(humanApiError(res.status, body)) as Error & { status?: number; body?: string };
    err.status = res.status;
    err.body = body;
    throw correlateError(err, requestIdFromResponse(res));
  }
  if (res.status === 204) return undefined as T;
  return consumeCorrelated(res, () => res.json() as Promise<T>);
}

/** One reason a save was rejected, as the backend's aggregated `validation_failed`
 *  response carries them (backend so-save-problems.ts). `line` is the offending
 *  item code; `field` the concrete input to fix. */
export type SaveProblem = { code: string; message: string; line?: string; field?: string };

/** Pull the aggregated problem list out of an API error body (the raw JSON string
 *  authed-fetch stashes on `err.body`). Returns null when the body isn't a
 *  `validation_failed` envelope — callers then fall back to the single message.
 *  Lets a surface render EVERY reason at once (owner 2026-07-18) instead of the
 *  one-at-a-time sequence the backend used to return. */
export function parseSaveProblems(body: string | undefined | null): SaveProblem[] | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { problems?: unknown };
    if (!Array.isArray(j.problems) || j.problems.length === 0) return null;
    return j.problems
      .filter((p): p is SaveProblem => !!p && typeof (p as SaveProblem).message === 'string')
      .map((p) => ({ code: String(p.code ?? ''), message: p.message, line: p.line, field: p.field }));
  } catch {
    return null;
  }
}

const ERROR_CODE_MESSAGES: Record<string, string> = {
  validation_failed: 'Some details need fixing before this can be saved.',
  idempotency_in_flight:
    "This is already going through — give it a moment, then refresh to check. Please don't send it again.",
  /* A PAYMENT THE BOOKS HAVE CLOSED OVER, or whose same-day window has passed
     (backend so-field-policy.ts, paymentRowMutable; 409 from both SO payment
     routes). The server's sentence names WHICH reconciliation and what to undo
     first, so it wins whenever it is sayable (SERVER_SENTENCE_WINS); this is
     the floor for a sentence the filter drops. Until docs/bugs/0821 that floor
     was the generic 409 — "That clashes with something already in the
     system. Please refresh and check." — which sent the operator to refresh a
     page that would refuse again, for a reason the server had written down. */
  payment_edit_locked:
    'This payment is locked, so it was not changed: it has been reconciled, or the day it was keyed in has passed. Ask Finance before recording it again.',
  /* A merchant report whose lines are all on a report uploaded earlier
     (docs/bugs/0823). The server names the earlier file; this is the floor
     when several names push its sentence past the filter. */
  already_on_report:
    'This file was not loaded: its transactions are already on a report uploaded earlier. The bank pays a card transaction once — open that batch instead.',
  idempotency_key_reused:
    'An earlier submission with different details already finished under this request key. Refresh and check what was recorded before sending it again.',
  idempotency_key_conflict:
    'This request key is already owned by another operation. Refresh and try again.',
  idempotency_unavailable:
    "We couldn't safely record this yet. Nothing was sent — wait a moment and try again.",
  idempotency_outcome_unknown:
    "We couldn't confirm whether this was recorded. Don't submit it again — refresh and check first.",
  invalid_idempotency_key:
    "This action couldn't be submitted safely. Refresh the page and try again.",
  idempotency_payload_too_large:
    'This upload is too large for safe retry. Upload the file separately.',
  migrated_source_document:
    'This delivery or receipt was carried over from AutoCount, so its invoice has to mirror the AutoCount one exactly — run the migrated-invoice converter instead of building it by hand.',
  qty_exceeds_remaining:
    'This line is already fully received on its purchase order, so no more can be received against it — refreshing will not change that. Receive the purchase-order line that still has an outstanding balance instead.',
  duplicate_code:   'That code is already in use. Please choose a different one.',
  phone_required:   'A phone number is required.',
  not_found:        'That item could no longer be found. Please refresh.',
  forbidden:        "You don't have permission to do that.",
  invalid_json:     'Something went wrong sending the request. Please try again.',
  // SO gates — curate the code so the operator never sees the raw sentence's
  // wording drift (owner 2026-07-14: Houzs Processing Date needs only 30%).
  processing_date_unpaid: 'A Processing Date needs at least 30% of the order total collected first.',
  processing_date_remove_forbidden:
    'Only a Super Admin can remove the Processing Date. Removing it pulls the order back out of Proceed — ask a Super Admin to do it.',
  so_sofa_no_other_main:  "A sofa order can't be mixed with bedframe or mattress items — use a separate order.",
  so_owned_by_2990:
    'This order belongs to 2990 and can only be changed in 2990. Any change made here would be undone automatically.',
  /* MIGRATED SALES ORDER, cutover lock (owner 2026-09-08). Curated here rather
     than left to the `message`/`reason` fallback for the reason the
     migrated_source_document block above records at length: the fallback keeps
     only a sentence under 200 characters, and a server sentence an operator can
     retype through scm.app_config.description has no such guarantee. A code with
     an entry here always renders; a code without one is one edit away from the
     status catch-all, which for a 409 reads "refresh and check" — advice that is
     a loop, because refreshing changes nothing about a migrated order. */
  so_migrated_readonly:
    'This order came from AutoCount, so it is view-only until its payments are reconciled. A new order saves normally. Ask IT if this one has to change today.',
  so_create_blocked_2990:
    'New orders for 2990 have to be created in 2990. An order created here would take a number 2990 is about to use, and would be overwritten.',
  so_version_conflict:
    'Someone else updated this order while you were editing. Your changes are still on this screen. Copy anything you need, then refresh to review the latest order.',
  so_version_required:
    'This order was opened with an older screen. Your changes are still here. Copy anything you need, then refresh the order before saving again.',
  po_version_conflict:
    'Someone else saved this purchase order while you were editing. Your changes are still on this screen. Copy anything you need, then refresh to review the latest order.',
  po_version_required:
    'This purchase order was opened with an older screen. Your changes are still here. Copy anything you need, then refresh the order before saving again.',
  so_version_invalid:
    'The order version is invalid. Your changes are still here. Refresh the order before saving again.',
  so_edit_lease_conflict:
    'This order is being saved on another screen. Your changes are still here. Wait a moment, then try Save again.',
  so_edit_lease_invalid:
    'This save session is no longer valid. Your changes are still here. Refresh the order before saving again.',
  so_total_below_original:
    "This change would bring the order's total below what the customer already agreed to. Put the amount back, or have a manager approve the lower price first.",
  payment_version_conflict:
    'Someone else changed this payment first. Your input is still here. Refresh the payments before trying again.',
  payment_version_required:
    'This payment was loaded without a version. Refresh the payments before changing it.',
  extra_addon_needs_description:
    'A special add-on charge needs a description. Fill in "Describe the special order..." next to the extra charge, or clear the amount.',
  company_unresolved:
    "We couldn't tell which company this belongs to. Please refresh and try again.",
  not_found_in_company:
    "That record isn't available in the company you're working in.",
  already_posted: 'This journal entry is already posted.',
  je_reversed:
    'This journal entry was reversed and cannot be posted. Create a new one.',
};

const SERVER_SENTENCE_WINS: ReadonlySet<string> = new Set(['so_migrated_readonly', 'payment_edit_locked', 'already_on_report']);

const isErrorCode = (s: string) => /^[a-z][a-z0-9_]*$/.test(s.trim());

export function humanApiError(status: number, body: string): string {
  try {
    const problems = parseSaveProblems(body);
    if (problems && problems.length > 0) {
      return problems.length === 1
        ? problems[0]!.message
        : problems.map((p) => `• ${p.message}`).join('\n');
    }
    const j = JSON.parse(body) as { error?: unknown; reason?: unknown; message?: unknown };
    const isPlain = (r: string) =>
      !!r && r.length < 200 && !r.trim().startsWith('{') && !isErrorCode(r) &&
      !/violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i.test(r);

    const withoutTail = (r: string) => r.replace(/\s*\([^()]*\)\s*(\.?)\s*$/, '$1').trim();
    const sayable = (raw: unknown): string | null => {
      if (typeof raw !== 'string') return null;
      if (isPlain(raw)) return raw;
      const trimmed = withoutTail(raw);
      return trimmed !== raw && isPlain(trimmed) ? trimmed : null;
    };
    if (typeof j.error === 'string') {
      const mapped = ERROR_CODE_MESSAGES[j.error];
      if (mapped && !SERVER_SENTENCE_WINS.has(j.error)) return mapped;
      if (mapped) {
        const perDocument = sayable(j.reason) ?? sayable(j.message);
        return perDocument ?? mapped;
      }
    }
    const detail = describeRefusal(j);
    if (detail) return detail;
    const said = sayable(j.message) ?? sayable(j.reason);
    if (said) return said;
  } catch { }
  if (status === 401) return 'Your session has expired — please sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return 'That item could no longer be found — it may have been changed or removed. Please refresh.';
  if (status === 409) return 'That clashes with something already in the system. Please refresh and check.';
  if (status === 400 || status === 422) return "Some of the details weren't accepted. Please check what you entered and try again.";
  if (status >= 500) return 'The system hit a problem. Please try again — if it keeps happening, let IT know.';
  return 'Something went wrong. Please try again.';
}

/* HC-0256: a 5xx keeps its friendly sentence, but the server's own reason was
   thrown away with it, so IT had nothing to go on. Give it back, labelled. */
export function itDetailOf(e: unknown): string {
  const err = e as { status?: unknown; body?: unknown } | null;
  if (typeof err?.status !== 'number' || err.status < 500 || typeof err.body !== 'string') return '';
  let said: unknown;
  try {
    const j = JSON.parse(err.body) as { reason?: unknown; message?: unknown };
    said = j.reason ?? j.message;
  } catch {
    return '';
  }
  if (typeof said !== 'string' || !said.trim() || said.trim().startsWith('{')) return '';
  if (humanApiError(err.status, err.body).includes(said.trim())) return '';
  const t = said.trim().slice(0, 300);
  return ` Details for IT: ${t}${/[.!?]$/.test(t) ? '' : '.'}`;
}
