// ----------------------------------------------------------------------------
// publicDoScan — the driver's three scans, reachable WITHOUT A LOGIN.
//
//   GET  /api/public/do-scan/:token           a minimal summary + the next rung
//   POST /api/public/do-scan/:token/advance   { to } — move exactly one rung
//
// THE OWNER'S DECISION, taken after the risk was put to him twice:
// 「就跟hookka一样」 — a public, no-login QR, exactly like Hookka's. The token
// printed on the paper IS the credential and there is nothing else between a
// stranger and the document. He accepted ONE addition: `qr_revoked_at`, so a
// leaked paper can be killed (mig 0328; the pattern is mig 0126's).
//
// This is a SIXTH way to close a delivery, and the first with nobody logged in
// behind it. Bugs 0480 and 0481 are why the page names what it does NOT collect
// before the button is pressed — DO_SCAN_DELIVERED_EVIDENCE_NOTE travels with
// the rung, so this route serves it and the page cannot render the button
// without it.
//
// ── TWO THINGS GET SCANNED ──────────────────────────────────────────────────
// The spec this change was given quotes the owner: 「这三个操作都可以通过 scan DO
// 或 scan packing list 来达成（scan packing list 会将该 list 内的货物统一全部出
// 完）」 — every rung reachable by scanning EITHER one delivery order OR the
// packing list, and scanning the packing list moves the WHOLE RUN at once.
//
// So a token resolves to one of two kinds, and the route branches on what the
// resolver reports rather than on anything in the request:
//
//   kind 'do'    one delivery order      one rung, one document
//   kind 'trip'  one packing list        the SAME rung, applied to every
//                                        delivery order on the run, in stop_no
//                                        order, ONE AT A TIME
//
// SEQUENTIALLY, NEVER IN PARALLEL, and this is bought experience rather than
// caution. Hookka wrote the reason down after paying for it (its delivery page,
// on the bulk transition): parallel DELIVERED batches DEADLOCKED because two
// delivery orders frequently share one sales order and their UPDATEs took the
// shared row in different lock order, and its auto-invoice numbering collided
// because a read-MAX-then-+1 ran before any sibling had committed. Houzs has
// the same shape — patchDeliveryOrderStatusHandler calls syncSoDeliveredFromDo,
// which updates the shared sales order, on every DELIVERED hop. One at a time
// lets each commit before the next starts.
//
// ONE MEMBER FAILING NEVER ABORTS THE REST. A driver holding the sheet needs to
// know which drop did not move, so every member gets its own line in the answer
// — done / already done / blocked / failed — and the run continues past a
// refusal. A half-moved run reported honestly beats an all-or-nothing that
// leaves him guessing.
//
// ── WHERE THE COMPANY COMES FROM ────────────────────────────────────────────
// A public route DOES have a company. It does not come from a session and it
// must never come from the request: it comes from `company_id` on the ONE ROW
// the token resolved to, which is NOT NULL (mig 0083) and unique per token (the
// UNIQUE index in mig 0328). `resolveDoScanToken` returns it as
// `resolved.companyId`, and every statement after the resolve — the line count
// here, and every read and write inside the status handler — is scoped to it and
// never widened.
//
// The SCM client is SERVICE-ROLE and mig 0061 enabled RLS with no policies, so
// nothing behind these statements re-checks anything: the predicate IS the
// tenant boundary. Bug 0497 is the record of what a single unscoped follow-up
// costs — a delivery order emptied the other company's rack because the rack
// read was by id alone — and the reason `publicDoScan.scope.test.ts` asserts the
// scope PER STATEMENT rather than per handler. `check-company-scope.mjs` acquits
// a whole handler on one scoped call (bug 0542), which is exactly how 0497 got
// through.
//
// ── ONE WRITER, NO SECOND PATH ──────────────────────────────────────────────
// The advance calls `patchDeliveryOrderStatusHandler` — the very function behind
// the office's PATCH /api/scm/delivery-orders-mfg/:id/status — through a
// synthetic context. Hookka's header states the reason and it holds here:
// "There is deliberately NO second write path to drift." Everything that hangs
// off a status flip (the inventory OUT, the SO delivered-qty resync, the
// customer email on the confirm hop, the over-delivery cap, the cancelled-is-
// final refusal) fires identically to an office click, because it IS the office
// click.
//
// WHAT A PUBLIC SCAN SUPPLIES AS ITS CALLER IDENTITY, said plainly rather than
// invented: `user` is `SCM_SYSTEM_STAFF_ID`, the same pinned scm.staff row that
// EVERY authenticated SCM write already carries (scm/middleware/auth.ts replaces
// the session user with it), so a scanned inventory movement is attributed
// exactly like an office one. `houzsUser` is left UNDEFINED, because there is no
// person — no fake user id is minted to fill the hole. Nothing this ladder can
// reach reads `houzsUser`: the capability gate reads it only for a
// `scmWriteBypassed` caller (this one is not), and the AutoCount cancel enqueue
// only on CANCELLED, which is not a rung.
//
// ── THE LADDER IS DECIDED HERE, NOT SENT ────────────────────────────────────
// The body names the rung it EXPECTS (`to`), and the server compares it against
// the rung `doScanStep` computes from the row's own status. The status written
// is always `step.status` — never a value off the request — so a tampered body
// can at most be refused. Forward-only is then two independent facts: the ladder
// only ever points forward, and `doScanRungIndex` refuses a target at or behind
// where the row already is.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { checkRateLimit, clientIp } from '../middleware/rateLimit';
import { getSupabaseService } from '../db/supabase';
import { SCM_SYSTEM_STAFF_ID } from '../scm/middleware/auth';
import { scopeToCompanyId } from '../scm/lib/companyScope';
import {
  DO_SCAN_TOKEN_RE,
  resolveScanToken,
  loadTripScanMembers,
  type ResolvedDoScan,
  type ResolvedTripScan,
  type TripScanMember,
} from '../scm/lib/do-scan-token';
import {
  doScanStep,
  doScanBlockReason,
  doScanConfirmation,
  doScanRungIndex,
  doScanLadderOrder,
  type DoScanStep,
} from '../scm/shared/do-scan-ladder';
import { patchDeliveryOrderStatusHandler } from '../scm/routes/delivery-orders-mfg';

export const publicDoScan = new Hono<{ Bindings: Env }>();

const readFailed = (c: Context<{ Bindings: Env }>) =>
  c.json(
    {
      error: 'scan_unavailable',
      message: 'We could not reach this delivery order just now. Wait a moment and scan again.',
    },
    503,
  );

const unknownToken = (c: Context<{ Bindings: Env }>) =>
  c.json(
    {
      error: 'unknown_token',
      message:
        'Unknown or expired QR code. Please ask the office for a freshly printed delivery order.',
    },
    404,
  );

const READ_MAX = 300;
const WRITE_MAX = 20;
const PER_TOKEN_MAX = 10;
const WINDOW_SEC = 900;

type PublicDoSummary = {
  doNumber: string;
  customerName: string;
  area: string;
  itemCount: number | null;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

async function countDoLines(sb: any, id: string, companyId: number): Promise<number | null> {
  const { count, error } = await scopeToCompanyId(
    sb.from('delivery_order_items').select('id', { count: 'exact', head: true })
      .eq('delivery_order_id', id),
    companyId,
  );
  if (error) return null;
  return typeof count === 'number' ? count : null;
}

async function buildSummary(sb: any, r: ResolvedDoScan): Promise<PublicDoSummary> {
  const step = doScanStep(r.status, r.onHold);
  return {
    doNumber: r.doNumber,
    customerName: r.customerName ?? '',
    area: [r.city, r.state].filter(Boolean).join(', '),
    itemCount: await countDoLines(sb, r.id, r.companyId),
    status: String(r.status ?? ''),
    step: step ? { status: step.status, label: step.label, note: step.note } : null,
    blockReason: doScanBlockReason(r.status, r.onHold),
  };
}

type PublicTripMember = {
  stopNo: number;
  doNumber: string | null;
  status: string | null;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

type PublicTripSummary = {
  kind: 'trip';
  tripNo: string;
  tripDate: string | null;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  members: PublicTripMember[];
};

const FOREIGN_MEMBER_REASON =
  'This drop is on another company\'s books, so this sheet cannot move it. Call the office.';

function nextRunStep(members: PublicTripMember[]): PublicTripMember['step'] | null {
  let best: PublicTripMember['step'] | null = null;
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const m of members) {
    if (!m.step) continue;
    const idx = doScanRungIndex(m.status);
    if (idx >= 0 && idx < bestIdx) { bestIdx = idx; best = m.step; }
    else if (best === null) best = m.step;
  }
  return best;
}

async function buildTripSummary(
  sb: any,
  trip: ResolvedTripScan,
  loaded: TripScanMember[],
): Promise<PublicTripSummary> {
  const members: PublicTripMember[] = loaded.map((m) => {
    if (m.foreign) {
      return { stopNo: m.stopNo, doNumber: null, status: null, step: null, blockReason: FOREIGN_MEMBER_REASON };
    }
    const step = doScanStep(m.status, m.onHold);
    return {
      stopNo: m.stopNo,
      doNumber: m.doNumber,
      status: String(m.status ?? ''),
      step: step ? { status: step.status, label: step.label, note: step.note } : null,
      blockReason: doScanBlockReason(m.status, m.onHold),
    };
  });
  const step = nextRunStep(members);
  return {
    kind: 'trip',
    tripNo: trip.tripNo,
    tripDate: trip.tripDate,
    status: String(trip.status ?? ''),
    step,
    blockReason: step
      ? null
      : members.length === 0
        ? 'There is nothing on this packing list yet. Call the office.'
        : 'Nothing on this run is waiting for a scan right now.',
    members,
  };
}

const OFF_RUNG_SINGLE =
  'This delivery order has moved on since this page was opened. Reload the page to see its next step.';
const OFF_RUNG_RUN =
  'This drop is at a different step from the rest of the run. Scan its own delivery order to move it.';
const OFF_RUNG_BATCH =
  'This delivery order is at a different step from the one you pressed, so it was not moved.';

type DocOutcome = {
  outcome: 'DONE' | 'ALREADY_DONE' | 'BLOCKED' | 'FAILED';
  from: string;
  to?: string;
  code?: string;
  message: string;
};

async function advanceOneDocument(
  c: Context<{ Bindings: Env }>,
  sb: unknown,
  resolved: ResolvedDoScan,
  wanted: string,
  offRung: string,
): Promise<DocOutcome> {
  const from = String(resolved.status ?? '');
  const wantedIdx = doScanRungIndex(wanted);
  const currentIdx = doScanRungIndex(from);

  if (wantedIdx >= 0 && currentIdx >= wantedIdx) {
    return {
      outcome: 'ALREADY_DONE',
      from,
      message: doScanConfirmation(wanted as DoScanStep['status']),
    };
  }

  const step = doScanStep(resolved.status, resolved.onHold);
  if (!step) {
    return {
      outcome: 'BLOCKED',
      from,
      message: doScanBlockReason(resolved.status, resolved.onHold) ?? '',
    };
  }
  if (step.status !== wanted) {
    return { outcome: 'BLOCKED', from, message: offRung };
  }
  if (!(wantedIdx > currentIdx)) {
    return {
      outcome: 'BLOCKED',
      from,
      message: 'This step would move the delivery order backwards, so it was not recorded.',
    };
  }

  const written = await advanceThroughOfficeWriter(c, sb, resolved, step.status);
  if (!written.ok) {
    console.warn('[public-do-scan] advance refused', {
      status: written.status, code: written.code, doNumber: resolved.doNumber,
    });
    return {
      outcome: 'FAILED',
      from,
      code: written.code,
      message: 'The office system would not record this step. Please call the office and quote this delivery order number.',
    };
  }

  return { outcome: 'DONE', from, to: step.status, message: doScanConfirmation(step.status) };
}

// ── THE BASKET: several papers scanned in a row, then ONE press ─────────────
//
// THE OWNER, 2026-08-26: 「我不能 scan 好几个 DO，然后一起点 load 吗？包括我的
// dispatch 也是一样，它应该可以支持连续扫描的。」 A storekeeper loading a lorry
// holds a pile of papers, not one; walking each of them through its own page is
// the work the QR was supposed to remove.
//
// TWO ENDPOINTS, AND THEY ARE REGISTERED BEFORE `/:token` ON PURPOSE. Hono
// matches in registration order, so `/batch/advance` declared after
// `/:token/advance` would be captured with token = "batch". It would still be
// refused — DO_SCAN_TOKEN_RE admits a 10-character or a 64-character token and
// "batch" is neither — so this is
// belt and braces rather than the only guard, but a 404 for a route that exists
// is a confusing way to find that out. publicDoScan.batch.test.ts pins the
// order by calling both.
//
// ONE REQUEST FOR THE WHOLE BASKET, not one per paper, and the reason is the
// rate limiter rather than tidiness: a warehouse is ONE public IP for every
// phone in it, so a per-paper read would spend the IP's whole allowance on a
// single lorry. See READ_MAX.
//
// WHY A CROSS-COMPANY BASKET IS SAFE HERE AND IS NOT ON A PACKING LIST. Each
// token in the basket IS the credential for its own document and resolves to
// its own row and its own company_id — scanning two companies' papers means
// holding two companies' papers. A packing list is the opposite shape: ONE sheet
// naming documents it does not authorise, which is why loadTripScanMembers
// refuses a foreign member and this does not have to.
const BATCH_MAX = 60;

const batchTooBig = (c: Context<{ Bindings: Env }>) =>
  c.json(
    {
      error: 'too_many',
      message: `Too many delivery orders in one go — scan up to ${BATCH_MAX}, press the button, then carry on.`,
    },
    400,
  );

function batchTokens(raw: unknown): { ok: true; tokens: string[] } | { ok: false } {
  if (!Array.isArray(raw)) return { ok: false };
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (DO_SCAN_TOKEN_RE.test(trimmed)) seen.add(trimmed);
  }
  if (seen.size > BATCH_MAX) return { ok: false };
  return { ok: true, tokens: [...seen] };
}

type BatchLine = {
  token: string;
  doNumber: string | null;
  customerName?: string;
  area?: string;
  status: string | null;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  outcome?: DocOutcome['outcome'] | 'UNKNOWN';
  from?: string;
  to?: string;
  message?: string;
};

const TRIP_IN_BATCH_REASON =
  'This is a packing list, not a delivery order. Open it on its own to move the whole run at once.';

publicDoScan.post('/batch/lookup', async (c) => {
  const limited = await checkRateLimit(c, 'do_scan_read', clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const body = (await c.req.json().catch(() => ({}))) as { tokens?: unknown };
  const parsed = batchTokens(body.tokens);
  if (!parsed.ok) return batchTooBig(c);

  const sb = getSupabaseService(c.env);
  const lines: BatchLine[] = [];
  for (const token of parsed.tokens) {
    const found = await resolveScanToken(sb, token);
    if (found.status === 'read_failed') {
      lines.push({
        token, doNumber: null, status: null, step: null,
        blockReason: 'We could not reach this delivery order just now. Scan it again in a moment.',
        outcome: 'UNKNOWN',
      });
      continue;
    }
    if (found.status === 'unknown') {
      lines.push({
        token, doNumber: null, status: null, step: null,
        blockReason: 'Unknown or expired QR code. Ask the office for a freshly printed delivery order.',
        outcome: 'UNKNOWN',
      });
      continue;
    }
    if (found.kind === 'trip') {
      lines.push({
        token, doNumber: found.row.tripNo, status: String(found.row.status ?? ''),
        step: null, blockReason: TRIP_IN_BATCH_REASON, outcome: 'BLOCKED',
      });
      continue;
    }
    const summary = await buildSummary(sb, found.row);
    lines.push({
      token,
      doNumber: summary.doNumber,
      customerName: summary.customerName,
      area: summary.area,
      status: summary.status,
      step: summary.step,
      blockReason: summary.blockReason,
    });
  }
  return c.json({ kind: 'batch', lines });
});

publicDoScan.post('/batch/advance', async (c) => {
  const ipLimited = await checkRateLimit(c, 'do_scan_write', clientIp(c), WRITE_MAX, WINDOW_SEC);
  if (ipLimited) return ipLimited;

  const body = (await c.req.json().catch(() => ({}))) as { tokens?: unknown; to?: unknown };
  const wanted = typeof body.to === 'string' ? body.to.trim().toUpperCase() : '';
  const TARGETS = doScanLadderOrder().slice(1);
  if (!wanted || !TARGETS.includes(wanted.toLowerCase())) {
    return c.json({
      error: 'step_required',
      message: 'That is not a step a delivery order can take. Reload the page and try again.',
    }, 400);
  }

  const parsed = batchTokens(body.tokens);
  if (!parsed.ok) return batchTooBig(c);
  if (parsed.tokens.length === 0) {
    return c.json({
      error: 'nothing_scanned',
      message: 'Nothing was scanned. Scan at least one delivery order first.',
    }, 400);
  }

  const sb = getSupabaseService(c.env);
  const lines: BatchLine[] = [];

  for (const token of parsed.tokens) {
    const perToken = await checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC);
    if (perToken) {
      lines.push({
        token, doNumber: null, status: null, step: null, blockReason: null,
        outcome: 'BLOCKED',
        message: 'This delivery order has been scanned too many times just now. Wait a few minutes.',
      });
      continue;
    }

    const found = await resolveScanToken(sb, token);
    if (found.status === 'read_failed') {
      lines.push({
        token, doNumber: null, status: null, step: null, blockReason: null,
        outcome: 'UNKNOWN',
        message: 'We could not reach this delivery order just now. Scan it again in a moment.',
      });
      continue;
    }
    if (found.status === 'unknown') {
      lines.push({
        token, doNumber: null, status: null, step: null, blockReason: null,
        outcome: 'UNKNOWN',
        message: 'Unknown or expired QR code. Ask the office for a freshly printed delivery order.',
      });
      continue;
    }
    if (found.kind === 'trip') {
      lines.push({
        token, doNumber: found.row.tripNo, status: String(found.row.status ?? ''),
        step: null, blockReason: null, outcome: 'BLOCKED', message: TRIP_IN_BATCH_REASON,
      });
      continue;
    }

    const decided = await advanceOneDocument(c, sb, found.row, wanted, OFF_RUNG_BATCH);
    lines.push({
      token,
      doNumber: found.row.doNumber,
      status: decided.to ?? decided.from,
      step: null,
      blockReason: null,
      outcome: decided.outcome,
      from: decided.from,
      ...(decided.to ? { to: decided.to } : {}),
      message: decided.message,
    });
  }

  const moved = lines.filter((l) => l.outcome === 'DONE').length;
  const already = lines.filter((l) => l.outcome === 'ALREADY_DONE').length;
  const stuck = lines.filter(
    (l) => l.outcome === 'BLOCKED' || l.outcome === 'FAILED' || l.outcome === 'UNKNOWN',
  ).length;
  const outcome = stuck > 0 ? 'PARTIAL' as const : moved > 0 ? 'DONE' as const : 'NOTHING' as const;
  const message =
    outcome === 'DONE'
      ? `${moved} ${moved === 1 ? 'delivery order' : 'delivery orders'} recorded.`
      : outcome === 'PARTIAL'
        ? `${moved} recorded, ${stuck} not moved — check the list and call the office about those.`
        : already > 0
          ? 'Everything scanned was already past this step. Nothing was changed.'
          : 'Nothing needed this step.';
  return c.json({ kind: 'batch', outcome, to: wanted, moved, already, stuck, message, lines });
});

publicDoScan.get('/:token', async (c) => {
  const token = (c.req.param('token') || '').trim();
  if (!DO_SCAN_TOKEN_RE.test(token)) return unknownToken(c);

  const limited = await checkRateLimit(c, 'do_scan_read', clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const sb = getSupabaseService(c.env);
  const found = await resolveScanToken(sb, token);
  if (found.status === 'read_failed') return readFailed(c);
  if (found.status === 'unknown') return unknownToken(c);
  if (found.kind === 'trip') {
    const loaded = await loadTripScanMembers(sb, found.row);
    if (loaded.status === 'read_failed') return readFailed(c);
    return c.json(await buildTripSummary(sb, found.row, loaded.members));
  }
  return c.json({ kind: 'do', ...(await buildSummary(sb, found.row)) });
});

publicDoScan.post('/:token/advance', async (c) => {
  const token = (c.req.param('token') || '').trim();
  if (!DO_SCAN_TOKEN_RE.test(token)) return unknownToken(c);

  const ipLimited = await checkRateLimit(c, 'do_scan_write', clientIp(c), WRITE_MAX, WINDOW_SEC);
  if (ipLimited) return ipLimited;
  const tokenLimited = await checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC);
  if (tokenLimited) return tokenLimited;

  const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
  const wanted = typeof body.to === 'string' ? body.to.trim().toUpperCase() : '';
  const TARGETS = doScanLadderOrder().slice(1);
  if (!wanted || !TARGETS.includes(wanted.toLowerCase())) {
    return c.json({
      error: 'step_required',
      message: 'This scan did not name a step this delivery order can take. Reload the page and try again.',
    }, 400);
  }

  const sb = getSupabaseService(c.env);
  const found = await resolveScanToken(sb, token);
  if (found.status === 'read_failed') return readFailed(c);
  if (found.status === 'unknown') return unknownToken(c);

  if (found.kind === 'trip') {
    const loaded = await loadTripScanMembers(sb, found.row);
    if (loaded.status === 'read_failed') return readFailed(c);
    return c.json(await advanceWholeRun(c, sb, found.row, loaded.members, wanted));
  }

  const resolved = found.row;

  const decided = await advanceOneDocument(c, sb, resolved, wanted, OFF_RUNG_SINGLE);
  return c.json(
    { doNumber: resolved.doNumber, ...decided },
    decided.outcome === 'FAILED' ? 409 : 200,
  );
});

async function advanceThroughOfficeWriter(
  c: Context<{ Bindings: Env }>,
  sb: unknown,
  resolved: ResolvedDoScan,
  to: string,
): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
  const vars = new Map<string, unknown>([
    ['supabase', sb],
    ['user', { id: SCM_SYSTEM_STAFF_ID }],
    ['houzsUser', undefined],
    ['scmWriteBypassed', false],
    ['companyId', resolved.companyId],
  ]);

  let captured: { body: any; status: number } | null = null;
  const synthetic = {
    env: c.env,
    req: {
      param: (k: string) => (k === 'id' ? resolved.id : undefined),
      json: async () => ({ status: to }),
    },
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => { vars.set(k, v); },
    json: (b: unknown, s?: number) => {
      captured = { body: b, status: s ?? 200 };
      return new Response(null, { status: s ?? 200 });
    },
  };

  try {
    await patchDeliveryOrderStatusHandler(synthetic as never);
  } catch (e) {
    console.error('[public-do-scan] status writer threw:', e);
    return { ok: false, status: 500, code: 'writer_threw' };
  }
  const res = captured as { body: any; status: number } | null;
  if (!res) return { ok: false, status: 500, code: 'no_response' };
  if (res.status >= 400) {
    return { ok: false, status: res.status, code: String(res.body?.error ?? 'refused') };
  }
  return { ok: true };
}

type MemberOutcome = {
  stopNo: number;
  doNumber: string | null;
  outcome: 'DONE' | 'ALREADY_DONE' | 'BLOCKED' | 'FAILED';
  from: string | null;
  to?: string;
  message: string;
};

async function advanceWholeRun(
  c: Context<{ Bindings: Env }>,
  sb: unknown,
  trip: ResolvedTripScan,
  members: TripScanMember[],
  wanted: string,
): Promise<{
  kind: 'trip'; tripNo: string; outcome: 'DONE' | 'PARTIAL' | 'NOTHING';
  to: string; message: string; members: MemberOutcome[];
}> {
  const results: MemberOutcome[] = [];

  for (const m of members) {
    if (m.foreign) {
      results.push({
        stopNo: m.stopNo, doNumber: null, outcome: 'BLOCKED', from: null,
        message: FOREIGN_MEMBER_REASON,
      });
      continue;
    }
    const decided = await advanceOneDocument(
      c, sb, { ...memberAsDo(m), companyId: trip.companyId }, wanted, OFF_RUNG_RUN,
    );
    if (decided.outcome === 'FAILED') {
      console.warn('[public-do-scan] run member refused', {
        tripNo: trip.tripNo, stopNo: m.stopNo, code: decided.code,
      });
    }
    results.push({
      stopNo: m.stopNo,
      doNumber: m.doNumber,
      outcome: decided.outcome,
      from: decided.from,
      ...(decided.to ? { to: decided.to } : {}),
      message: decided.outcome === 'FAILED'
        ? 'The office system would not record this drop. Call the office and quote this delivery order number.'
        : decided.message,
    });
  }

  const moved = results.filter((r) => r.outcome === 'DONE').length;
  const stuck = results.filter((r) => r.outcome === 'BLOCKED' || r.outcome === 'FAILED').length;
  const outcome = stuck > 0 ? 'PARTIAL' as const : moved > 0 ? 'DONE' as const : 'NOTHING' as const;
  const message =
    outcome === 'DONE'
      ? `All ${moved} ${moved === 1 ? 'drop' : 'drops'} recorded.`
      : outcome === 'PARTIAL'
        ? `${moved} recorded, ${stuck} not moved — check the list below and call the office about those.`
        : 'Nothing on this run needed this step.';
  return { kind: 'trip', tripNo: trip.tripNo, outcome, to: wanted, message, members: results };
}

function memberAsDo(m: TripScanMember): ResolvedDoScan {
  return {
    id: m.doId,
    companyId: 0,
    doNumber: m.doNumber ?? '',
    customerName: null,
    city: null,
    state: null,
    status: m.status,
    onHold: m.onHold,
  };
}
