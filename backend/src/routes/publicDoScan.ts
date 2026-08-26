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

/* ONE SENTENCE FOR "no such token" AND FOR "this token was killed". A revoked
   token must not get a message of its own: telling the holder of a leaked paper
   that it USED to work is the single fact the kill switch exists to withhold.
   resolveDoScanToken already collapses both cases to `null`, so there is only
   one branch here to keep honest. */
const readFailed = (c: Context<{ Bindings: Env }>) =>
  c.json(
    {
      error: 'scan_unavailable',
      message: 'We could not reach this delivery order just now. Wait a moment and scan again.',
    },
    503,
  );

/* A BLIP IS NOT A DEAD CODE. 503, not the 404 above — telling a driver at a
   lorry that his paper is unknown because the database hiccuped is the same
   dishonesty as not binding the error in the first place. It leaks nothing: a
   failed read fails for every token alike, so the answer says nothing about the
   one in hand, unlike revocation, which is exactly why THAT one is folded into
   the unknown answer and this one is not. */
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
/* RAISED FROM 30 ON 2026-08-26, and the reason is NAT rather than generosity.
   `clientIp` is the PUBLIC address, and a warehouse is ONE public address for
   every phone inside it — so 30 reads per quarter-hour was 30 reads for the
   whole floor, not per person. A storekeeper loading a single lorry scans
   thirty papers; the second person to pick up a phone found the code dead. The
   basket endpoint below spends one read for a whole pile, which is the real fix,
   but the single-paper page still spends one per scan and shares this bucket.

   What keeps it safe is not this number: DO_SCAN_TOKEN_RE admits only 64 hex, so
   enumeration is hopeless at any rate, and the WRITE limits — which are what
   actually move a document — are untouched at 20 per address and 10 per
   document. */
const READ_MAX = 300;
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

/** One drop on a packing list, as the public sheet sees it. */
type PublicTripMember = {
  stopNo: number;
  /** Null for a member on another company's books — withheld on purpose. */
  doNumber: string | null;
  status: string | null;
  /** The rung THIS member is ready for, or null with a reason beside it. */
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

/** A whole run, summarised. Same minimisation rules as one delivery order. */
type PublicTripSummary = {
  kind: 'trip';
  tripNo: string;
  tripDate: string | null;
  status: string;
  /** The ONE rung the run as a whole is offered — see nextRunStep. */
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  members: PublicTripMember[];
};

const FOREIGN_MEMBER_REASON =
  'This drop is on another company\'s books, so this sheet cannot move it. Call the office.';

/**
 * The ONE rung a whole run is offered.
 *
 * A run is a pile of documents that are usually, but not always, on the same
 * rung — one drop may have been advanced by its own delivery-order QR. Offering
 * the rung the FURTHEST-BEHIND movable member is ready for is what makes the
 * sheet's single button honest: press it and everything that can take that step
 * takes it, and everything already past it reports "already done" rather than
 * being dragged forward a second time.
 *
 * Deliberately NOT the majority rung and NOT the first member's: both would skip
 * a straggler, and a skipped drop on a delivery run is a customer who does not
 * get their goods logged.
 */
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

/* THE OFF-RUNG SENTENCE, one per caller, because the same fact needs different
   words depending on what the person is holding. Everything ELSE about the
   decision is shared — see advanceOneDocument. */
const OFF_RUNG_SINGLE =
  'This delivery order has moved on since this page was opened. Reload the page to see its next step.';
const OFF_RUNG_RUN =
  'This drop is at a different step from the rest of the run. Scan its own delivery order to move it.';
const OFF_RUNG_BATCH =
  'This delivery order is at a different step from the one you pressed, so it was not moved.';

/** What happened to ONE delivery order. Shared by all three callers. */
type DocOutcome = {
  outcome: 'DONE' | 'ALREADY_DONE' | 'BLOCKED' | 'FAILED';
  from: string;
  to?: string;
  code?: string;
  message: string;
};

/**
 * DECIDE AND, IF THE LADDER ALLOWS IT, WRITE — for exactly one delivery order.
 *
 * THE POINT OF THIS FUNCTION IS THAT THERE IS ONLY ONE OF IT. Three surfaces
 * move a delivery order without a login — one paper, a whole packing list, and
 * (2026-08-26) a basket of papers scanned in a row — and before this extraction
 * two of them carried their own hand-written copy of the same five checks in the
 * same order. That is the duplicated-decision class this repo gates on, and the
 * ladder is the worst thing in the system to hold twice: a copy that gains a
 * check the other has not is a delivery order that moves on the phone and not in
 * the books. The batch endpoint would have been the THIRD copy.
 *
 * The order of the checks is load-bearing and is the single-document path's
 * original order, kept exactly:
 *
 *   1. ALREADY AT OR PAST the asked-for rung → an ANSWER, not an error, and
 *      FIRST because it is the common case on a dock (a double press, a replayed
 *      request, a re-scanned sheet). Checking it before the ladder is what stops
 *      a second press from silently taking the NEXT rung instead.
 *   2. NO STEP AT ALL (held, cancelled, closed, unknown status) → the sentence
 *      the person reads instead of a button. Never silence.
 *   3. OFF-RUNG — the ladder computed a different next step from the one asked
 *      for. Not moved, and said so, rather than pushed onto a rung the ladder
 *      did not compute for it.
 *   4. FORWARD ONLY, asserted rather than assumed. Check 3 already pins the
 *      target to the ladder's own computation and the ladder only points
 *      forward; this is the second, independent fact, so a future edit that made
 *      a rung point backwards fails here instead of writing.
 *   5. Write through the office's own status handler.
 *
 * `offRung` is the ONLY thing the callers vary, and it is a sentence rather than
 * a flag on purpose: a driver holding one paper, a driver holding a packing
 * list, and a storekeeper holding a pile need different words for the same fact.
 */
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
      /* Safe cast: every caller pins `wanted` to doScanLadderOrder() before
         calling, so it is a DoScanStep['status'] by here and the switch inside
         doScanConfirmation is total. */
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
    /* The office writer's own refusal bodies quote the caller's input and name
       internal fields; none of that goes to a public page. The stable error
       CODE does — it carries no data and it is what the office needs to be told
       — and the full body is logged. */
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
// refused — DO_SCAN_TOKEN_RE admits only 64 hex, and "batch" is not — so this is
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

/**
 * The tokens of a request body, shape-checked and de-duplicated.
 *
 * DE-DUPLICATION IS NOT COSMETIC. A held paper decodes every frame; the page
 * de-dupes too, but a basket that reached here with the same token twice would
 * be walked twice, and the second walk would find the document one rung further
 * on and report ALREADY_DONE against a line the operator never scanned twice.
 * Cheaper and more honest to collapse it here as well.
 *
 * A token of the wrong SHAPE is dropped rather than refused: one bad decode in a
 * pile of thirty must not cost the operator the other twenty-nine. It comes back
 * as an unknown line in the answer, because `unknown` is exactly what it is.
 */
function batchTokens(raw: unknown): { ok: true; tokens: string[] } | { ok: false } {
  if (!Array.isArray(raw)) return { ok: false };
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (DO_SCAN_TOKEN_RE.test(trimmed)) seen.add(trimmed);
  }
  /* REFUSED, NEVER TRUNCATED, and the first version of this function got it
     wrong: it stopped adding at the cap and returned what it had, so a basket of
     eighty papers would have moved sixty and reported success — the operator
     reads "60 recorded", walks away, and twenty papers are still sitting on the
     lorry with the wrong status. A silent cap on a delivery floor is worse than
     a refusal, because the refusal is visible. Counted AFTER de-duplication so a
     paper that decoded twice does not eat the allowance. */
  if (seen.size > BATCH_MAX) return { ok: false };
  return { ok: true, tokens: [...seen] };
}

/** One line in a basket answer — what the operator reads beside a document. */
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

/* A packing list scanned INTO a basket. Not an error and not silently dropped:
   the sheet has its own whole-run button on its own page, and saying so is more
   use than a shrug. */
const TRIP_IN_BATCH_REASON =
  'This is a packing list, not a delivery order. Open it on its own to move the whole run at once.';

// ── POST /batch/lookup ──────────────────────────────────────────────────────
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
      /* A BLIP IS NOT A DEAD CODE — the same rule the single read follows. The
         basket keeps going so one hiccup does not blank the other lines, and
         this line says "try again" rather than "unknown". */
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

// ── POST /batch/advance ─────────────────────────────────────────────────────
publicDoScan.post('/batch/advance', async (c) => {
  const ipLimited = await checkRateLimit(c, 'do_scan_write', clientIp(c), WRITE_MAX, WINDOW_SEC);
  if (ipLimited) return ipLimited;

  const body = (await c.req.json().catch(() => ({}))) as { tokens?: unknown; to?: unknown };
  const wanted = typeof body.to === 'string' ? body.to.trim().toUpperCase() : '';
  /* THE SAME DERIVED TARGET LIST the single paper checks against — the ladder's
     own order minus DRAFT, which nothing scans to. Bug 0530 is why a rung the
     enum does not define is refused here instead of reaching a query. */
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

  /* SEQUENTIALLY, NEVER IN PARALLEL — the same reason the packing list walks its
     drops one at a time, written up at the top of this file: two delivery orders
     frequently share one sales order, and syncSoDeliveredFromDo updates that
     shared row on every DELIVERED hop. Hookka deadlocked doing this in parallel.
     A basket is MORE exposed than a run, not less: a run is one customer's day,
     a basket is whatever the storekeeper picked up. */
  for (const token of parsed.tokens) {
    const perToken = await checkRateLimit(c, 'do_scan_doc', token, PER_TOKEN_MAX, WINDOW_SEC);
    if (perToken) {
      /* The per-document limiter survives the batch: a basket must not become
         the way to hammer one document from one address. It reports as a line
         rather than failing the request, so the other papers still move. */
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
  /* THE HEADLINE IS ABOUT WHAT THE OPERATOR STILL HAS TO DO, so one refusal
     outranks twenty successes — the same rule the packing list follows. A
     storekeeper who reads "all done" and walks away from a paper that did not
     move is the failure this wording exists to prevent. */
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

/** What happened to ONE drop when the whole run was advanced. */
type MemberOutcome = {
  stopNo: number;
  /** Null for a foreign member — withheld, never printed on a public page. */
  doNumber: string | null;
  outcome: 'DONE' | 'ALREADY_DONE' | 'BLOCKED' | 'FAILED';
  from: string | null;
  to?: string;
  message: string;
};

/**
 * Apply ONE rung to every delivery order on a packing list.
 *
 * THREE PROPERTIES, each of which is the answer to a specific way this could go
 * wrong on a dock:
 *
 *  1. SEQUENTIAL. `for … await`, never Promise.all. Two drops on one run
 *     frequently share a sales order, and patchDeliveryOrderStatusHandler
 *     updates it (syncSoDeliveredFromDo) on the delivered hop — run them
 *     together and they take the shared row in different lock order and
 *     deadlock. Hookka's bulk transition carries the same rule and the incident
 *     that bought it.
 *  2. ONE REFUSAL NEVER ABORTS THE REST. Every member is attempted and every
 *     member gets a line. The driver needs to know WHICH drop did not move; an
 *     all-or-nothing tells him nothing and leaves the run half-recorded anyway
 *     the moment anything is already done.
 *  3. THE STRANGER IS REFUSED BEFORE IT IS TOUCHED. A foreign member is
 *     `BLOCKED` without a write and without its document number. Everything else
 *     is written scoped to THE RUN'S company, which is where
 *     advanceThroughOfficeWriter takes it from.
 */
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
    /* ONE DECISION FUNCTION, shared with the single paper and the batch — see
       advanceOneDocument. This loop's only remaining job is to turn the answer
       into a line the driver reads beside a STOP NUMBER, and to say "drop"
       where the shared wording says "delivery order". */
    const decided = await advanceOneDocument(
      c, sb, { ...memberAsDo(m), companyId: trip.companyId }, wanted, OFF_RUNG_RUN,
    );
    if (decided.outcome === 'FAILED') {
      /* The shared function already logged the document; this adds the run
         context, which is what the office is asked about. */
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
  /* The headline is about what the DRIVER has to do next, so "some of it did not
     move" outranks "most of it did". A run with even one refusal is PARTIAL. */
  const outcome = stuck > 0 ? 'PARTIAL' as const : moved > 0 ? 'DONE' as const : 'NOTHING' as const;
  const message =
    outcome === 'DONE'
      ? `All ${moved} ${moved === 1 ? 'drop' : 'drops'} recorded.`
      : outcome === 'PARTIAL'
        ? `${moved} recorded, ${stuck} not moved — check the list below and call the office about those.`
        : 'Nothing on this run needed this step.';
  return { kind: 'trip', tripNo: trip.tripNo, outcome, to: wanted, message, members: results };
}

/**
 * A run member, in the shape the single-document writer already takes.
 *
 * `companyId` is overwritten by the caller with the RUN's — never this member's
 * own — so the write cannot follow a row that turned out to be somewhere else
 * between the read and the write. The other fields carry no weight past the
 * writer's `id`.
 */
function memberAsDo(m: TripScanMember): ResolvedDoScan {
  return {
    id: m.doId,
    companyId: 0, // replaced by the caller; never used from here
    doNumber: m.doNumber ?? '',
    customerName: null,
    city: null,
    state: null,
    status: m.status,
    onHold: m.onHold,
  };
}
