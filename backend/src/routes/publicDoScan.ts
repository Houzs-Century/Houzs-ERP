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
  resolveDoScanToken,
  type ResolvedDoScan,
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

/* ONE SENTENCE FOR "no such token" AND FOR "this token was killed". A revoked
   token must not get a message of its own: telling the holder of a leaked paper
   that it USED to work is the single fact the kill switch exists to withhold.
   resolveDoScanToken already collapses both cases to `null`, so there is only
   one branch here to keep honest. */
const unknownToken = (c: Context<{ Bindings: Env }>) =>
  c.json(
    {
      error: 'unknown_token',
      message:
        'Unknown or expired QR code. Please ask the office for a freshly printed delivery order.',
    },
    404,
  );

/* RATE LIMITS, set against what this repo's existing public surfaces already
   carry so this one is no looser than the loosest of them: survey_read is
   30/900s per IP and survey_submit / track are 20/900s (routes/survey.ts,
   routes/track.ts). The read here takes survey_read's numbers; the advance takes
   the tighter write numbers AND a second limiter keyed by the TOKEN, so a
   document cannot be hammered from rotating addresses — which no existing
   surface does, because none of them writes to a document identified by the
   credential itself. checkRateLimit fails OPEN when KV is unbound (tests/dev). */
const READ_MAX = 30;
const WRITE_MAX = 20;
const PER_TOKEN_MAX = 10;
const WINDOW_SEC = 900;

/** The ONLY fields a stranger holding the paper ever sees. */
type PublicDoSummary = {
  doNumber: string;
  customerName: string;
  area: string;
  itemCount: number | null;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

/**
 * Count this delivery order's lines.
 *
 * SCOPED, and the company id is a required argument for the reason bug 0497
 * exists: `delivery_order_id` proves the line is on that document, never whose
 * document it is (the standing company-scope rule (b)). `company_id` is NOT NULL
 * on scm.delivery_order_items (mig 0083), so the predicate cannot silently drop
 * a legitimate line.
 */
async function countDoLines(sb: any, id: string, companyId: number): Promise<number | null> {
  const { count, error } = await scopeToCompanyId(
    sb.from('delivery_order_items').select('id', { count: 'exact', head: true })
      .eq('delivery_order_id', id),
    companyId,
  );
  /* `null`, NEVER 0, when the read did not answer. supabase-js does not throw,
     so an unbound error reads as an empty document — and "0 lines" on a paper
     with goods behind it is a claim about the load, not a report of what we
     hold. The page renders a dash. */
  if (error) return null;
  return typeof count === 'number' ? count : null;
}

async function buildSummary(sb: any, r: ResolvedDoScan): Promise<PublicDoSummary> {
  const step = doScanStep(r.status, r.onHold);
  return {
    doNumber: r.doNumber,
    customerName: r.customerName ?? '',
    /* THE AREA, NOT THE ADDRESS. City + state is what the logged-in scan page
       shows too (DoLoadScan), and it is enough for a driver to know he is at
       the right paper. The street line, the postcode, the phone number and
       every money column stay on the authenticated side, and
       publicDoScan.minimisation.test.ts fails the build if this file so much as
       mentions one of them. */
    area: [r.city, r.state].filter(Boolean).join(', '),
    itemCount: await countDoLines(sb, r.id, r.companyId),
    status: String(r.status ?? ''),
    step: step ? { status: step.status, label: step.label, note: step.note } : null,
    blockReason: doScanBlockReason(r.status, r.onHold),
  };
}

// ── GET /:token ─────────────────────────────────────────────────────────────
publicDoScan.get('/:token', async (c) => {
  const token = (c.req.param('token') || '').trim();
  /* THE SHAPE GATE COMES FIRST, before the limiter and before any query. A
     token that is not 64 hex cannot exist, so probing with junk must cost a
     regex and never a database round trip. */
  if (!DO_SCAN_TOKEN_RE.test(token)) return unknownToken(c);

  const limited = await checkRateLimit(c, 'do_scan_read', clientIp(c), READ_MAX, WINDOW_SEC);
  if (limited) return limited;

  const sb = getSupabaseService(c.env);
  const resolved = await resolveDoScanToken(sb, token);
  if (!resolved) return unknownToken(c);
  return c.json(await buildSummary(sb, resolved));
});

// ── POST /:token/advance ────────────────────────────────────────────────────
publicDoScan.post('/:token/advance', async (c) => {
  const token = (c.req.param('token') || '').trim();
  if (!DO_SCAN_TOKEN_RE.test(token)) return unknownToken(c);

  const ipLimited = await checkRateLimit(c, 'do_scan_write', clientIp(c), WRITE_MAX, WINDOW_SEC);
  if (ipLimited) return ipLimited;
  const tokenLimited = await checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC);
  if (tokenLimited) return tokenLimited;

  const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
  const wanted = typeof body.to === 'string' ? body.to.trim().toUpperCase() : '';
  /* A RUNG THE LADDER ACTUALLY HAS, checked before anything else looks at it.
     The targets are the ladder's own order minus its starting rung — DRAFT is
     where a delivery order begins and nothing scans TO it — derived, never
     typed. Bug 0530 is why this is a refusal and not a shrug: a status literal
     `scm.do_status` does not define is a 22P02 that 500s, not an empty match,
     and it took the Delivery Orders page down for two days. */
  const TARGETS = doScanLadderOrder().slice(1);
  if (!wanted || !TARGETS.includes(wanted.toLowerCase())) {
    return c.json({
      error: 'step_required',
      message: 'This scan did not name a step this delivery order can take. Reload the page and try again.',
    }, 400);
  }

  const sb = getSupabaseService(c.env);
  const resolved = await resolveDoScanToken(sb, token);
  if (!resolved) return unknownToken(c);

  const from = String(resolved.status ?? '');
  const wantedIdx = doScanRungIndex(wanted);
  const currentIdx = doScanRungIndex(from);

  /* IDEMPOTENCE, and it is the FIRST thing checked because it is the common
     case on a dock: the driver presses twice, or the phone replays the request.
     "The document is already at or past the rung you asked for" is an ANSWER,
     not an error — and checking it before the ladder is what stops a second
     press from silently taking the NEXT rung instead, which is the shape of the
     defect a naive re-scan would produce. */
  if (wantedIdx >= 0 && currentIdx >= wantedIdx) {
    return c.json({
      outcome: 'ALREADY_DONE',
      doNumber: resolved.doNumber,
      from,
      /* Safe cast: TARGETS above admits only the ladder's own step targets, so
         `wanted` is a DoScanStep['status'] by then and the switch is total. */
      message: doScanConfirmation(wanted as DoScanStep['status']),
    });
  }

  const step = doScanStep(resolved.status, resolved.onHold);
  if (!step) {
    /* Held, cancelled, already closed, or a status the ladder does not know.
       200 with a sentence, not an error: the person is standing at a lorry and
       needs to read what to do, and doScanBlockReason is the same sentence the
       logged-in page shows. It never returns null when doScanStep is null. */
    return c.json({
      outcome: 'BLOCKED',
      doNumber: resolved.doNumber,
      from,
      message: doScanBlockReason(resolved.status, resolved.onHold) ?? '',
    });
  }
  if (step.status !== wanted) {
    return c.json({
      outcome: 'BLOCKED',
      doNumber: resolved.doNumber,
      from,
      message: 'This delivery order has moved on since this page was opened. Reload the page to see its next step.',
    });
  }
  /* FORWARD ONLY, asserted rather than assumed. The line above already pins the
     target to what the ladder computed from the row's own status, and the
     ladder only ever points forward — this is the second, independent fact, so
     a future edit that made a rung point backwards fails here instead of
     writing. Unreachable today, and that is what the test proves. */
  if (!(wantedIdx > currentIdx)) {
    return c.json({
      outcome: 'BLOCKED',
      doNumber: resolved.doNumber,
      from,
      message: 'This step would move the delivery order backwards, so it was not recorded.',
    });
  }

  const written = await advanceThroughOfficeWriter(c, sb, resolved, step.status);
  if (!written.ok) {
    /* The office writer's own refusal bodies quote the caller's input and name
       internal fields; none of that goes to a public page. The stable error
       CODE does — it carries no data and it is what the office needs to be told
       — and the full body is logged. */
    console.warn('[public-do-scan] advance refused', {
      status: written.status, code: written.code, doNumber: resolved.doNumber,
    });
    return c.json({
      outcome: 'FAILED',
      doNumber: resolved.doNumber,
      from,
      code: written.code,
      message: 'The office system would not record this step. Please call the office and quote this delivery order number.',
    }, 409);
  }

  return c.json({
    outcome: 'DONE',
    doNumber: resolved.doNumber,
    from,
    to: step.status,
    message: doScanConfirmation(step.status),
  });
});

/**
 * Run the OFFICE's status writer, with the company taken from the resolved row.
 *
 * The synthetic context is the whole trick, and it is a narrow one on purpose:
 * it hands the handler exactly the five variables it reads and nothing else, so
 * there is no session-shaped object lying around for a future edit to widen.
 * `companyId` is `resolved.companyId` — the row's own — which means every
 * `scopeToCompanyId(...)` inside the handler (the load, both update branches,
 * the rack read on cancel) filters to that one company. There is no path by
 * which a value from the request reaches it: the request supplies a token and a
 * rung name, and neither is a company.
 */
async function advanceThroughOfficeWriter(
  c: Context<{ Bindings: Env }>,
  sb: unknown,
  resolved: ResolvedDoScan,
  to: string,
): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
  const vars = new Map<string, unknown>([
    ['supabase', sb],
    /* The pinned scm.staff identity every authenticated SCM write already
       carries — imported, never a uuid typed here a second time. */
    ['user', { id: SCM_SYSTEM_STAFF_ID }],
    /* No person is logged in, and that is recorded rather than faked. */
    ['houzsUser', undefined],
    /* NOT a capability-bypass caller. The bypass gate exists for a storekeeper
       or driver who holds scm.do.load / scm.do.dispatch WITHOUT delivery edit;
       a scan has no position to read, so it must not claim one. */
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
