// ----------------------------------------------------------------------------
// venture-portal-catalogue — the SENDER for the ERP -> Venture Portal CATALOGUE
// push: the SKU master, the Modular models with their allowed options, the
// Bedframe / Sofa maintenance pools, specials, fabrics and sofa combos.
//
// ITEMS ONLY — the owner's rule for the portal's mirror (2026-09-24): every
// price the portal measures a margin against is typed over there. So the body
// is built, and every price and cost left behind, in SQL by
// scm.vp_build_catalogue (migration 20260923T1843). This file never sees a
// price to strip: it decides WHEN to send and what the answer means.
//
// GATED EXACTLY LIKE THE ORDER FEED, with the same helpers: the switch and its
// company scope (venture-portal-feed-flag.ts), vp.url and vp.secret. vp.since
// does not apply — a catalogue has no date. The receiver is vp.url's sibling:
// .../sales-orders -> .../products. A vp.url that does not end in /sales-orders
// is NOT guessed at; nothing is sent and the status page says why.
//
// NO OUTBOX, ON PURPOSE. A catalogue moves a few times a day and is sent
// whole, so "what changed" is one md5 in SQL (scm.vp_catalogue_digest), asked
// on every */5 cron run: 32 bytes over the wire when nothing changed. The body
// travels only when that digest differs from the one the portal last accepted
// (scm.venture_portal_catalogue_state).
//
// ONE SECTION, ONE POST. `full: true` makes the portal retire every row of a
// section the delivery carries but does not mention, so a section split across
// two posts would retire half of itself. A body over the size budget is split
// BY SECTION only (planVpCatalogueParts). Measured 2026-09-24: company 1's
// catalogue is ~1.2 MB, one post.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { readFeedScope, type FeedScope } from './venture-portal-feed-flag';
import { classifyVpResponse, readVpConfig } from './venture-portal-outbox';

/* The SCM PostgREST client is untyped at every call site in this tree; a typed
   signature here would describe a contract nothing else keeps. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type ScmClient = SupabaseClient<any, any, any>;

/** The size budget for one POST. The portal runs on Vercel, whose request body
 *  limit is 4.5 MB; three leaves room for the headers and for growth. */
export const VP_CATALOGUE_MAX_POST_BYTES = 3_000_000;

/** Generous: the portal ingests ~4,000 rows in one transaction per post. */
export const VP_CATALOGUE_TIMEOUT_MS = 90_000;

/**
 * The sections a body can carry, in the order they are POSTED when a body has
 * to be split. Models before products: the portal adopts a model from its SKUs
 * only once the model row exists, and it re-runs that adoption after every
 * post, so this order finishes the job one post earlier. Only these keys are
 * forwarded: a section scm.vp_build_catalogue gains must be added here too.
 */
export const VP_CATALOGUE_SECTIONS = ['models', 'products', 'maintenance', 'specials', 'fabrics', 'combos'] as const;
export type VpCatalogueSection = (typeof VP_CATALOGUE_SECTIONS)[number];

/** What scm.vp_build_catalogue returns. */
export type VpCatalogueBody = { companyId: number; full: boolean } & Partial<Record<VpCatalogueSection, unknown>>;

/** A row of scm.venture_portal_catalogue_state, as far as the decision reads it. */
export type VpCatalogueState = {
  delivered_digest: string | null;
  last_digest: string | null;
  last_outcome: string | null;
};

/** One POST: which sections it carries and the exact bytes it sends. */
export type VpCataloguePart = { sections: VpCatalogueSection[]; body: string; bytes: number };

export type VpCatalogueOutcome = ReturnType<typeof classifyVpResponse>['outcome'];

export type VpCatalogueCompanyResult = {
  companyId: number;
  /** unchanged / refused_unchanged: nothing was sent. build_failed: the SQL did
   *  not answer, nothing was sent, next run tries again. */
  action: 'unchanged' | 'refused_unchanged' | 'build_failed' | VpCatalogueOutcome;
  digest: string | null;
  parts: number;
  bytes: number;
  httpStatus: number | null;
  note: string | null;
};

export type VpCatalogueSummary = { skipped?: string; companies: VpCatalogueCompanyResult[] };

/** Why vpCatalogueUrl answered null — one sentence for the log and the page. */
export const VP_CATALOGUE_URL_PROBLEM =
  'vp.url is not an https URL ending in /sales-orders, so the /products receiver cannot be derived';

/**
 * The catalogue receiver, derived from the order feed's: a trailing
 * /sales-orders becomes /products. Anything else answers null — the two
 * endpoints are one deployment's siblings, and a URL of any other shape is one
 * this code would only be guessing about.
 */
export function vpCatalogueUrl(salesOrdersUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(salesOrdersUrl.trim());
  } catch {
    return null;
  }
  /* https only, as PUT /connection enforces for the order feed: the shared
     secret travels in a header. */
  if (u.protocol !== 'https:' || u.search !== '' || u.hash !== '') return null;
  const m = /^(.*)\/sales-orders\/?$/.exec(u.pathname);
  if (!m) return null;
  u.pathname = `${m[1]}/products`;
  return u.toString();
}

/**
 * Should this company's catalogue be sent? PURE.
 *
 * `refused_unchanged`: the portal answered 400/413/422 to these exact bytes,
 * and sending them again every five minutes would only repeat the refusal. A
 * new digest (somebody fixed the catalogue) or a forced send tries again.
 */
export function vpCatalogueDecision(
  digest: string,
  state: VpCatalogueState | null,
  force: boolean,
): 'send' | 'unchanged' | 'refused_unchanged' {
  if (force) return 'send';
  if (state?.delivered_digest != null && state.delivered_digest === digest) return 'unchanged';
  if (state?.last_outcome === 'failed' && state.last_digest === digest) return 'refused_unchanged';
  return 'send';
}

/**
 * The order feed's taxonomy (classifyVpResponse), plus one answer that is
 * specific to a body this size: 413 is the platform refusing the BYTES, and
 * the same bytes will be refused again, so it is parked like a 422.
 */
export function classifyVpCatalogueResponse(status: number): { outcome: VpCatalogueOutcome; note: string } {
  if (status === 413) {
    return { outcome: 'failed', note: 'http 413 — over the portal`s request size limit even when split by section; a person must look' };
  }
  const v = classifyVpResponse(status);
  return { outcome: v.outcome, note: v.note };
}

/**
 * What a run's answers mean, as one verdict. PURE.
 *
 * `statuses` are the HTTP answers in order — the run stops at the first
 * non-2xx, so everything before the last one was a 2xx.
 *
 * `delivered` is what happens to the recorded `delivered_digest`, which must
 * only ever describe what the portal actually holds:
 *   - replace: every post was accepted — the portal holds this digest;
 *   - keep:    the first post was refused with a 4xx or a 503, both answered
 *              BEFORE anything is written (the receiver checks the key and
 *              parses the body before its one ingest call, and a platform 503
 *              means the function never ran) — it still holds the old one;
 *   - clear:   anything else. An earlier post of this run was applied, so its
 *              sections are the new ones now; or the answer does not prove the
 *              post was not applied (a 500, 502 or 504, a timeout or a dropped
 *              connection can arrive after the portal committed). Cleared, the
 *              next run sends again whatever the digest, instead of trusting a
 *              record that may be wrong.
 */
export function vpCatalogueVerdict(
  statuses: number[],
  partCount: number,
): { outcome: VpCatalogueOutcome; delivered: 'replace' | 'keep' | 'clear'; note: string } {
  const ok = (s: number) => s >= 200 && s <= 299;
  if (statuses.length === partCount && statuses.every(ok)) {
    return { outcome: 'sent', delivered: 'replace', note: '' };
  }
  const last = statuses[statuses.length - 1] ?? 0;
  const verdict = classifyVpCatalogueResponse(last);
  const refusedUnwritten = statuses.length === 1 && ((last >= 400 && last <= 499) || last === 503);
  return {
    outcome: verdict.outcome,
    delivered: refusedUnwritten ? 'keep' : 'clear',
    note: partCount > 1 ? `post ${statuses.length} of ${partCount}: ${verdict.note}` : verdict.note,
  };
}

/**
 * Cut a body into POSTs of at most `maxBytes`, never splitting a section. PURE.
 *
 * Every part is a complete delivery on its own — companyId, full: true, the
 * one snapshotAt of this run — carrying whole sections, packed in
 * VP_CATALOGUE_SECTIONS order. A single section larger than the budget goes
 * alone and over it: splitting it would retire the rows its other half carries
 * (see the file header), which is worse than a 413 a person can see.
 */
export function planVpCatalogueParts(
  body: VpCatalogueBody,
  snapshotAt: string,
  maxBytes: number,
): VpCataloguePart[] {
  const enc = new TextEncoder();
  const sections = VP_CATALOGUE_SECTIONS.filter((s) => body[s] !== undefined && body[s] !== null);
  const prefix = `{"companyId":${JSON.stringify(body.companyId)},"full":true,"snapshotAt":${JSON.stringify(snapshotAt)}`;
  const pieces = new Map(sections.map((s) => [s, `,${JSON.stringify(s)}:${JSON.stringify(body[s])}`] as const));
  /* UTF-8 lengths add up across concatenation, so each piece is encoded once
     and a candidate part is sized by addition. */
  const pieceBytes = new Map(sections.map((s) => [s, enc.encode(pieces.get(s)).length] as const));
  const frameBytes = enc.encode(prefix).length + 1;
  const bytesOf = (group: VpCatalogueSection[]) =>
    group.reduce((n, s) => n + (pieceBytes.get(s) ?? 0), frameBytes);
  const make = (group: VpCatalogueSection[]): VpCataloguePart => ({
    sections: group,
    body: `${prefix}${group.map((s) => pieces.get(s)).join('')}}`,
    bytes: bytesOf(group),
  });

  if (bytesOf(sections) <= maxBytes) return [make(sections)];

  const groups: VpCatalogueSection[][] = [];
  let current: VpCatalogueSection[] = [];
  for (const s of sections) {
    if (current.length > 0 && bytesOf([...current, s]) > maxBytes) {
      groups.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length > 0) groups.push(current);
  return groups.map(make);
}

function inScope(scope: FeedScope, companyId: number): boolean {
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  return scope.includes(companyId);
}

/** The companies a scope covers. `all` is every company the ERP knows; null
 *  means the list could not be read, which is not the same as "none". */
async function companiesFor(sb: ScmClient, scope: Exclude<FeedScope, 'off'>): Promise<number[] | null> {
  if (scope !== 'all') return [...scope];
  /* public.companies is the companies MASTER; the SCM client is pinned to the
     scm schema, so it has to be asked for by name (scm/lib/doc-no.ts). */
  const { data, error } = await sb.schema('public').from('companies').select('id').order('id', { ascending: true });
  if (error) return null;
  return ((data as { id: number | string }[] | null) ?? [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** The portal's own word for what it did, kept as JSON when it is JSON. */
function portalAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500) || null;
  }
}

/**
 * One POST. Never throws: a transport failure is an outcome, reported as
 * status 0 so it is retried. The secret goes in the header the order feed
 * uses, and is never logged or returned.
 */
async function postPart(
  url: string,
  secret: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string; transportError: string | null }> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body,
      signal: AbortSignal.timeout(VP_CATALOGUE_TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text().catch(() => ''), transportError: null };
  } catch (e) {
    return { status: 0, text: '', transportError: String((e as Error | undefined)?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// LIVE, NOT EVERY FIVE MINUTES (owner 2026-09-24: "i want it live, like current
// sales order sync, not 5 min").
//
// A write to any table the catalogue is built from — the SKU master, Modular,
// the maintenance config, specials, fabrics, combos — adds a row to
// scm.venture_portal_catalogue_changes in the SAME transaction (statement
// triggers, migration *_scm_vp_catalogue_live.sql; only the columns the
// catalogue sends count, so a cost or stock update marks nothing). After every
// SCM write the kick drains the order queue and then runs
// pushVenturePortalCatalogueOnChange: while a mark is there, the digest is
// asked and the catalogue sent if it changed — seconds after the Save, however
// the change was made. The */5 cron still runs the same push and stays the
// safety net for a change made outside a request.
// ---------------------------------------------------------------------------

/** How many marks one run clears. A burst beyond it is cleared by the next run. */
export const VP_CATALOGUE_CHANGES_BATCH = 1_000;

/**
 * Clear the change marks this run covers. Called FIRST by every push — the kick
 * and the cron alike — so a mark written while the run builds survives it and
 * earns the next one, and the table stays small even while the feed is off.
 * A failure is logged and ignored: a mark left behind costs one more digest.
 */
async function clearCatalogueChanges(sb: ScmClient): Promise<void> {
  const { data, error } = await sb
    .from('venture_portal_catalogue_changes')
    .select('id')
    .order('id', { ascending: true })
    .limit(VP_CATALOGUE_CHANGES_BATCH);
  if (error) {
    console.error('[vp-catalogue] could not read the change marks', error.message);
    return;
  }
  const ids = ((data as Array<{ id: number | string }> | null) ?? []).map((r) => r.id);
  if (!ids.length) return;
  const { error: delErr } = await sb.from('venture_portal_catalogue_changes').delete().in('id', ids);
  if (delErr) console.error('[vp-catalogue] could not clear the change marks', delErr.message);
}

/**
 * The kick's step after the order drain: send the catalogue if a catalogue table
 * changed. While the feed is off it costs the one cached flag read the drain
 * already made; with no mark, one read of an empty table.
 */
export async function pushVenturePortalCatalogueOnChange(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<VpCatalogueSummary> {
  const sb = getSupabaseService(env);
  if ((await readFeedScope(sb)) === 'off') return { skipped: 'feed_off', companies: [] };
  const { data, error } = await sb.from('venture_portal_catalogue_changes').select('id').limit(1);
  if (error) return { skipped: 'changes_read_failed', companies: [] };
  if (!(data as unknown[] | null)?.length) return { skipped: 'unchanged', companies: [] };
  return pushVenturePortalCatalogue(env, { force: false }, fetchImpl);
}

/**
 * Send each in-scope company's catalogue if it changed since the portal last
 * accepted it — or regardless, when `force` (the admin page's "send now").
 *
 * Never throws for a delivery problem: every answer is recorded on the
 * company's state row and returned. A failed read aborts BEFORE anything is
 * sent, because not knowing what was delivered is not a reason to send.
 */
export async function pushVenturePortalCatalogue(
  env: Env,
  opts: { force: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<VpCatalogueSummary> {
  const sb = getSupabaseService(env);

  await clearCatalogueChanges(sb);

  const scope = await readFeedScope(sb);
  if (scope === 'off') return { skipped: 'feed_off', companies: [] };

  const cfg = await readVpConfig(sb);
  if (!cfg) return { skipped: 'not_configured', companies: [] };

  const url = vpCatalogueUrl(cfg.url);
  if (!url) {
    /* [vp-catalogue] is the string to alert on. The status page shows the same
       fact (catalogue.url is null), so nobody has to read a log to find it. */
    console.error(`[vp-catalogue] ${VP_CATALOGUE_URL_PROBLEM}; nothing sent`);
    return { skipped: 'catalogue_url_unknown', companies: [] };
  }

  const companies = await companiesFor(sb, scope);
  if (companies === null) return { skipped: 'companies_read_failed', companies: [] };
  if (!companies.length) return { companies: [] };

  const { data: stateData, error: stateErr } = await sb
    .from('venture_portal_catalogue_state')
    .select('company_id, delivered_digest, last_digest, last_outcome')
    .in('company_id', companies);
  if (stateErr) return { skipped: 'state_read_failed', companies: [] };
  const stateByCompany = new Map<number, VpCatalogueState>(
    ((stateData as (VpCatalogueState & { company_id: number | string })[] | null) ?? [])
      .map((r) => [Number(r.company_id), r]),
  );

  const results: VpCatalogueCompanyResult[] = [];
  for (const companyId of companies) {
    /* Re-read per company (cached 30 s): off must stop the next delivery, not
       finish the round. */
    if (!inScope(await readFeedScope(sb), companyId)) break;

    const result: VpCatalogueCompanyResult = {
      companyId, action: 'build_failed', digest: null, parts: 0, bytes: 0, httpStatus: null, note: null,
    };
    results.push(result);

    if (!opts.force) {
      const { data: digest, error } = await sb.rpc('vp_catalogue_digest', { p_company_id: companyId });
      if (error || typeof digest !== 'string' || !digest) {
        result.note = `the catalogue digest could not be computed: ${error?.message ?? 'no answer'}`;
        continue;
      }
      result.digest = digest;
      const decision = vpCatalogueDecision(digest, stateByCompany.get(companyId) ?? null, false);
      if (decision !== 'send') {
        result.action = decision;
        continue;
      }
    }

    /* The body AND its digest from one build: the digest recorded below always
       describes the bytes that were sent, even if the catalogue changed since
       the digest was asked for above. */
    const { data: snap, error: snapErr } = await sb.rpc('vp_catalogue_snapshot', { p_company_id: companyId });
    const snapshot = snap as { digest?: unknown; body?: unknown } | null;
    if (
      snapErr
      || typeof snapshot?.digest !== 'string'
      || snapshot.body === null
      || typeof snapshot.body !== 'object'
      || Array.isArray(snapshot.body)
    ) {
      result.note = `the catalogue could not be built: ${snapErr?.message ?? 'no answer'}`;
      continue;
    }
    const digest = snapshot.digest;
    result.digest = digest;

    const parts = planVpCatalogueParts(snapshot.body as VpCatalogueBody, new Date().toISOString(), VP_CATALOGUE_MAX_POST_BYTES);
    result.parts = parts.length;
    result.bytes = parts.reduce((n, p) => n + p.bytes, 0);

    const statuses: number[] = [];
    const answers: unknown[] = [];
    let failureText = '';
    for (const part of parts) {
      const res = await postPart(url, cfg.secret, part.body, fetchImpl);
      statuses.push(res.status);
      if (res.status >= 200 && res.status <= 299) {
        answers.push({ sections: part.sections, bytes: part.bytes, status: res.status, result: portalAnswer(res.text) });
        continue;
      }
      failureText = res.transportError ?? res.text.slice(0, 300);
      break;
    }

    const verdict = vpCatalogueVerdict(statuses, parts.length);
    const now = new Date().toISOString();
    result.action = verdict.outcome;
    result.httpStatus = statuses[statuses.length - 1] ?? null;
    result.note = verdict.outcome === 'sent' ? null : `${verdict.note}${failureText ? ` — ${failureText}` : ''}`;

    const row: Record<string, unknown> = {
      company_id: companyId,
      last_digest: digest,
      last_outcome: verdict.outcome,
      last_attempt_at: now,
      last_http_status: result.httpStatus,
      last_error: result.note,
      last_bytes: result.bytes,
      last_parts: result.parts,
      updated_at: now,
    };
    if (verdict.delivered === 'replace') {
      row.delivered_digest = digest;
      row.delivered_at = now;
      row.portal_result = answers;
    } else if (verdict.delivered === 'clear') {
      row.delivered_digest = null;
    }
    /* A lost write leaves the previous record in place, so the next run sees a
       digest it never recorded as delivered and normally sends again. It is
       reported in the result and the log, not retried here. */
    const { error: writeErr } = await sb
      .from('venture_portal_catalogue_state')
      .upsert(row, { onConflict: 'company_id' });
    if (writeErr) {
      console.error('[vp-catalogue] could not record the delivery state', companyId, writeErr.message);
      result.note = `${result.note ? `${result.note}; ` : ''}state not recorded: ${writeErr.message}`;
    }
  }

  return { companies: results };
}
