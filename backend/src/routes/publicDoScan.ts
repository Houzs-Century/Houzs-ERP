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
//   kind 'trip'  one packing list        "SCAN WHEN FULLY LOADED": every
//                                        delivery order on the run to Loaded
//                                        (DISPATCHED) and no other rung, in
//                                        stop_no order, ONE AT A TIME (2026-11-27)
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
  loadLorryDayMembers,
  type LorryDayMember,
  type ResolvedLorryDayScan,
} from '../scm/lib/lorry-day-scan';
import {
  doScanStep,
  doScanBlockReason,
  doScanConfirmation,
  doScanRungIndex,
  doScanLadderOrder,
  type DoScanStep,
} from '../scm/shared/do-scan-ladder';
import { patchDeliveryOrderStatusHandler } from '../scm/routes/delivery-orders-mfg';
import {
  LORRY_LOAD_DONE,
  LORRY_LOAD_TARGET,
  decideLorryLoad,
  dominantPlate,
  sheetLoadHeadline,
} from '../scm/lib/lorry-load-scan';
import {
  checkPackingScanStep,
  fmtMalaysiaTime,
  markSheetLoaded,
  markSheetPrepared,
  nextPackingScanStep,
} from '../scm/lib/packing-scan-steps';

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

// -- THE PACKING LIST: "SCAN WHEN FULLY LOADED" ---------------------------------
// Owner, 2026-11-27: "QR code scan了就是全部loaded了". The packing-list scan has ONE
// meaning: every delivery order on the sheet becomes Loaded (DB DISPATCHED). It never
// confirms a Draft (that takes stock out and is the office's call), never moves
// anything past Loaded and never moves anything back. scm/lib/lorry-load-scan.ts
// decides each drop; the write is the office writer's, the same as "Mark Loaded".
// Drops are written one at a time with `expectFrom`, so a drop that moved on since
// the read is refused rather than dragged back, and a second scan writes nothing.
// Two kinds of sheet carry this QR: a trip (scm.trips, its stops) and a lorry-day
// sheet (scm.packing_scan_sets, the DO ids printed on it, mig 20261128T0100). Both
// become one ScanSheet and run through the same code. On a trip the lorry plate
// (headline only) is the crew plate most drops carry, and a failed read of it falls
// back to the packing-list number; on a lorry-day sheet it is the printed plate, and
// a DO whose crew plate changed since printing is left alone (MOVED).
type PublicTripMember = {
  stopNo: number;
  doNumber: string | null;
  customerName: string | null;
  status: string | null;
  willLoad: boolean;
  note: string;
};

type SheetKind = 'trip' | 'lorry_day' | 'region_day';

type ScanSheet = {
  kind: SheetKind;
  title: string;
  region: string | null;
  twoStep: ResolvedLorryDayScan | null;
  companyId: number;
  tripNo: string | null;
  sheetDate: string | null;
  sheetStatus: string;
  lorryPlate: string | null;
  members: LorryDayMember[];
};

type PublicTripSummary = {
  kind: SheetKind;
  mode: 'load_all';
  tripNo: string | null;
  tripDate: string | null;
  lorryPlate: string | null;
  region: string | null;
  title: string;
  nextStep: 'prepare' | 'load' | 'done' | null;
  preparedAt: string | null;
  preparedAtText: string;
  loadedAt: string | null;
  loadedAtText: string;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  members: PublicTripMember[];
};

const LOAD_ALL_LABEL = 'Mark whole lorry loaded';
const LOAD_ALL_NOTE =
  'Press this once everything on this packing list is on the lorry. Every confirmed delivery order on it is marked Loaded. Stock is not touched: it left when each delivery order was confirmed.';
const LOAD_NOTHING_NOTE =
  'Nothing on this packing list will change status (see each line below). Pressing still records the time it was loaded.';
const PREPARE_LABEL = 'Mark packing list prepared';
const PREPARE_NOTE =
  'Press this when everything on this packing list is picked and ready. It only records the prepared time; no delivery order changes. Scan the same QR again when the lorry is loaded.';

type ScanDb = ReturnType<typeof getSupabaseService>;

async function lorryPlateFor(sb: ScanDb, companyId: number, members: TripScanMember[]): Promise<string | null> {
  const ids = members.filter((m) => !m.foreign).map((m) => m.doId);
  if (ids.length === 0) return null;
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_order_crew').select('do_id, lorry_plate').in('do_id', ids),
    companyId,
  );
  if (error) return null;
  return dominantPlate((data as Array<{ lorry_plate: string | null }>).map((r) => r.lorry_plate));
}

async function tripSheet(sb: ScanDb, trip: ResolvedTripScan, members: TripScanMember[]): Promise<ScanSheet> {
  const lorryPlate = await lorryPlateFor(sb, trip.companyId, members);
  return {
    kind: 'trip',
    title: lorryPlate ? `Lorry ${lorryPlate}` : `Packing list ${trip.tripNo}`,
    region: null,
    twoStep: null,
    companyId: trip.companyId,
    tripNo: trip.tripNo,
    sheetDate: trip.tripDate,
    sheetStatus: String(trip.status ?? ''),
    lorryPlate,
    members: members.map((m) => ({ ...m, movedReason: null })),
  };
}

function lorryDaySheet(set: ResolvedLorryDayScan, members: LorryDayMember[]): ScanSheet {
  const isRegion = set.sheetKind === 'region';
  return {
    kind: isRegion ? 'region_day' : 'lorry_day',
    title: isRegion ? `Region ${set.region ?? ''}` : `Lorry ${set.lorryPlate ?? ''}`,
    region: isRegion ? set.region : null,
    twoStep: set,
    companyId: set.companyId,
    tripNo: null,
    sheetDate: set.deliveryDate,
    sheetStatus: '',
    lorryPlate: set.lorryPlate,
    members,
  };
}

type SheetToken =
  | { kind: 'trip'; row: ResolvedTripScan }
  | { kind: 'lorry_day'; row: ResolvedLorryDayScan };

async function loadSheet(sb: ScanDb, found: SheetToken): Promise<ScanSheet | null> {
  if (found.kind === 'trip') {
    const loaded = await loadTripScanMembers(sb, found.row);
    return loaded.status === 'ok' ? tripSheet(sb, found.row, loaded.members) : null;
  }
  const loaded = await loadLorryDayMembers(sb, found.row);
  return loaded.status === 'ok' ? lorryDaySheet(found.row, loaded.members) : null;
}

const decideMember = (m: LorryDayMember) => decideLorryLoad(m.status, m.onHold, m.foreign, m.movedReason);

function buildTripSummary(sheet: ScanSheet): PublicTripSummary {
  const decided = sheet.members.map((m) => ({ m, d: decideMember(m) }));
  const next = sheet.twoStep ? nextPackingScanStep(sheet.twoStep.preparedAt, sheet.twoStep.loadedAt) : null;
  const members: PublicTripMember[] = decided.map(({ m, d }) => ({
    stopNo: m.stopNo,
    doNumber: m.doNumber,
    customerName: m.customerName,
    status: m.foreign ? null : String(m.status ?? ''),
    willLoad: d.action === 'write' && next !== 'done',
    note: d.action === 'write'
      ? next === 'prepare' ? 'Will be marked Loaded at the loaded scan.' : 'Will be marked Loaded.'
      : d.message,
  }));
  const anyToLoad = members.some((m) => m.willLoad);
  const allLoaded = decided.length > 0
    && decided.every(({ d }) => d.action === 'skip' && d.outcome !== 'BLOCKED' && d.outcome !== 'MOVED');
  const alreadyLoaded = decided.filter(({ d }) => d.action === 'skip' && d.outcome === 'ALREADY_DONE').length;
  const times = {
    region: sheet.region,
    title: sheet.title,
    nextStep: next,
    preparedAt: sheet.twoStep?.preparedAt ?? null,
    preparedAtText: fmtMalaysiaTime(sheet.twoStep?.preparedAt ?? null),
    loadedAt: sheet.twoStep?.loadedAt ?? null,
    loadedAtText: fmtMalaysiaTime(sheet.twoStep?.loadedAt ?? null),
  };
  const head = {
    kind: sheet.kind,
    mode: 'load_all' as const,
    tripNo: sheet.tripNo,
    tripDate: sheet.sheetDate,
    lorryPlate: sheet.lorryPlate,
    ...times,
    status: sheet.sheetStatus,
  };
  if (next === 'prepare') {
    return { ...head, step: { status: 'prepare', label: PREPARE_LABEL, note: PREPARE_NOTE }, blockReason: null, members };
  }
  if (next === 'load') {
    return {
      ...head,
      step: { status: LORRY_LOAD_TARGET, label: LOAD_ALL_LABEL, note: anyToLoad ? LOAD_ALL_NOTE : LOAD_NOTHING_NOTE },
      blockReason: null,
      members,
    };
  }
  if (next === 'done') return { ...head, step: null, blockReason: null, members };
  return {
    ...head,
    step: anyToLoad ? { status: LORRY_LOAD_TARGET, label: LOAD_ALL_LABEL, note: LOAD_ALL_NOTE } : null,
    blockReason: anyToLoad
      ? null
      : members.length === 0
        ? 'There is nothing on this packing list yet. Call the office.'
        : allLoaded
          ? 'Everything on this lorry is already loaded. Nothing to do.'
          : `Nothing left that this scan can load: ${alreadyLoaded} of ${members.length} already loaded. See each line below, and call the office about the rest.`,
    members,
  };
}

const sheetLabel = (found: SheetToken) =>
  found.kind === 'trip'
    ? found.row.tripNo
    : `${found.row.sheetKind === 'region' ? `Region ${found.row.region}` : `Lorry ${found.row.lorryPlate}`} ${found.row.deliveryDate}`;

const OFF_RUNG_SINGLE =
  'This delivery order has moved on since this page was opened. Reload the page to see its next step.';
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

  const written = await advanceThroughOfficeWriter(c, sb, resolved, step.status, null);
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
    if (found.kind !== 'do') {
      lines.push({
        token, doNumber: sheetLabel(found), status: null,
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
    if (found.kind !== 'do') {
      lines.push({
        token, doNumber: sheetLabel(found), status: null,
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
  if (found.kind !== 'do') {
    const sheet = await loadSheet(sb, found);
    if (!sheet) return readFailed(c);
    return c.json(buildTripSummary(sheet));
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

  const body = (await c.req.json().catch(() => ({}))) as { to?: unknown; step?: unknown };
  const wanted = typeof body.to === 'string' ? body.to.trim().toUpperCase() : '';
  const TARGETS = doScanLadderOrder().slice(1);
  const namesLadderStep = !!wanted && TARGETS.includes(wanted.toLowerCase());
  if (!namesLadderStep && body.step === undefined) {
    return c.json({
      error: 'step_required',
      message: 'This scan did not name a step this delivery order can take. Reload the page and try again.',
    }, 400);
  }

  const sb = getSupabaseService(c.env);
  const found = await resolveScanToken(sb, token);
  if (found.status === 'read_failed') return readFailed(c);
  if (found.status === 'unknown') return unknownToken(c);

  if (found.kind === 'lorry_day') {
    const set = found.row;
    const check = checkPackingScanStep(body.step, wanted || null, set.preparedAt, set.loadedAt);
    if (!check.ok) return c.json({ error: check.code, message: check.message }, check.status);
    if (check.step === 'prepare') {
      const stamped = check.already
        ? { status: 'ok' as const, at: set.preparedAt ?? '' }
        : await markSheetPrepared(sb, set, new Date().toISOString());
      if (stamped.status === 'read_failed') return readFailed(c);
      const title = set.sheetKind === 'region' ? `Region ${set.region ?? ''}` : `Lorry ${set.lorryPlate ?? ''}`;
      return c.json({
        kind: set.sheetKind === 'region' ? 'region_day' : 'lorry_day',
        mode: 'prepare',
        outcome: check.already ? 'ALREADY_DONE' : 'DONE',
        headline: `${title}: packing list prepared`,
        message: `Prepared at ${fmtMalaysiaTime(stamped.at)}. Scan the same QR again when the lorry is loaded.`,
        preparedAt: stamped.at,
        preparedAtText: fmtMalaysiaTime(stamped.at),
      });
    }
    const sheet = await loadSheet(sb, found);
    if (!sheet) return readFailed(c);
    const result = await loadWholeLorry(c, sb, sheet);
    const stamped = await markSheetLoaded(sb, set, new Date().toISOString());
    const loadedAt = stamped.status === 'ok' ? stamped.at : null;
    return c.json({
      ...result,
      message: loadedAt
        ? result.message
        : [result.message, 'The loaded time could not be saved. Scan again to record it; nothing will be loaded twice.'].filter(Boolean).join(' '),
      preparedAt: set.preparedAt,
      preparedAtText: fmtMalaysiaTime(set.preparedAt),
      loadedAt,
      loadedAtText: fmtMalaysiaTime(loadedAt),
    });
  }

  if (!namesLadderStep) {
    return c.json({
      error: 'step_required',
      message: 'This scan did not name a step this delivery order can take. Reload the page and try again.',
    }, 400);
  }

  if (found.kind !== 'do') {
    if (wanted !== LORRY_LOAD_TARGET) {
      return c.json({
        error: 'load_only',
        message: 'This packing list only records that the lorry is fully loaded. Reload the page.',
      }, 400);
    }
    const sheet = await loadSheet(sb, found);
    if (!sheet) return readFailed(c);
    return c.json(await loadWholeLorry(c, sb, sheet));
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
  expectFrom: string | null,
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
      json: async () => (expectFrom === null ? { status: to } : { status: to, expectFrom }),
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
  customerName: string | null;
  outcome: 'DONE' | 'ALREADY_DONE' | 'PAST' | 'BLOCKED' | 'MOVED' | 'FAILED';
  from: string | null;
  to?: string;
  status: string | null;
  message: string;
};

const WRITER_REFUSED: Record<string, string> = {
  status_changed: 'its status changed while this scan was running. Scan again.',
};

async function loadWholeLorry(
  c: Context<{ Bindings: Env }>,
  sb: ScanDb,
  sheet: ScanSheet,
): Promise<{
  kind: SheetKind; mode: 'load_all'; tripNo: string | null; lorryPlate: string | null; region: string | null;
  outcome: 'DONE' | 'PARTIAL' | 'NOTHING'; to: string; headline: string; message: string;
  total: number; loaded: number; moved: number; members: MemberOutcome[];
}> {
  const results: MemberOutcome[] = [];

  for (const m of sheet.members) {
    const base = { stopNo: m.stopNo, doNumber: m.doNumber, customerName: m.customerName };
    const d = decideMember(m);
    if (d.action === 'skip') {
      const seen = m.foreign ? null : d.from;
      results.push({ ...base, outcome: d.outcome, from: seen, status: seen, message: d.message });
      continue;
    }
    const written = await advanceThroughOfficeWriter(
      c, sb, { ...memberAsDo(m), companyId: sheet.companyId }, LORRY_LOAD_TARGET, d.from,
    );
    if (!written.ok) {
      console.warn('[public-do-scan] lorry load refused', {
        tripNo: sheet.tripNo, lorryPlate: sheet.lorryPlate, stopNo: m.stopNo, status: written.status, code: written.code,
      });
      results.push({
        ...base, outcome: 'FAILED', from: d.from, status: d.from,
        message: `Not loaded: ${WRITER_REFUSED[written.code] ?? 'the office system would not record it. Call the office and quote this delivery order number.'}`,
      });
      continue;
    }
    results.push({
      ...base, outcome: 'DONE', from: d.from, to: LORRY_LOAD_TARGET, status: LORRY_LOAD_TARGET,
      message: LORRY_LOAD_DONE,
    });
  }

  const moved = results.filter((r) => r.outcome === 'DONE').length;
  const loaded = moved + results.filter((r) => r.outcome === 'ALREADY_DONE').length;
  const past = results.filter((r) => r.outcome === 'PAST').length;
  const stuck = results.filter((r) => r.outcome === 'BLOCKED' || r.outcome === 'MOVED' || r.outcome === 'FAILED').length;
  const outcome = stuck > 0 ? 'PARTIAL' as const : moved > 0 ? 'DONE' as const : 'NOTHING' as const;
  const lorryPlate = sheet.lorryPlate;
  const message = [
    past > 0 ? `${past} already further along and left as ${past === 1 ? 'it is' : 'they are'}.` : '',
    stuck > 0 ? `${stuck} not loaded: see the list below and call the office about ${stuck === 1 ? 'it' : 'them'}.` : '',
    moved === 0 && stuck === 0 && loaded > 0 ? 'Nothing changed: it was all loaded already.' : '',
  ].filter(Boolean).join(' ');
  return {
    kind: sheet.kind,
    mode: 'load_all',
    tripNo: sheet.tripNo,
    lorryPlate,
    region: sheet.region,
    outcome,
    to: LORRY_LOAD_TARGET,
    headline: sheetLoadHeadline(sheet.title, loaded, results.length),
    message,
    total: results.length,
    loaded,
    moved,
    members: results,
  };
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
