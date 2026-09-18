/* FOUR FAILURES THAT LOOK ALIKE, AND THE ONE ANSWER NOBODY COULD GET.
 *
 * `GET /api/admin/health/autocount/host-build` exists because a change to
 * `backend/scripts/autocount-service/AcSyncService.cs` ships INERT: the exe is
 * rebuilt on the office machine by `deploy-on-host.ps1`, our deploy cannot do
 * it, and until somebody walks over there our half of the change is merged and
 * doing nothing. `/health` has carried `builtAt` + `mvid` since 2026-08-15 and
 * only the outbox drain ever read them, onto a row, after the fact.
 *
 * A diagnostic is only worth trusting if it can come back with the UNWELCOME
 * answer, so the fakes below are a service that can be OLD (no build keys at
 * all), MUTE (keys present, both null), REFUSING (401 / 503), STOPPED (the
 * tunnel answering for it) or GONE (nothing answers). Each of those is a
 * different job for whoever reads the payload, and collapsing them into "the
 * host is down" is what #2686 cost a day to.
 *
 * It also pins the two disciplines the route is answerable for: the gate, and
 * that neither `AC_SYNC_URL` nor `AC_SYNC_KEY` can reach the response.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Hono } from 'hono';

import health, { stripUrls } from './systemHealth';

const URL_SECRET = 'https://autocount.example-tunnel.test';
const KEY_SECRET = 'k3y-that-must-never-be-echoed';
const ENV = { AC_SYNC_URL: URL_SECRET, AC_SYNC_KEY: KEY_SECRET };

/** Every request the route made, so "read-only" is observed and not asserted. */
let CALLS: { url: string; method: string; key: string | null; body: string | null }[] = [];

/** A host that answers `/health` with a given status and body, like http.sys
 *  does — the JSON-ness of the body is part of the signal, so it is sent as
 *  text exactly as the service (or the tunnel in front of it) would. */
function hostAnswering(status: number, body: string) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    CALLS.push({
      url: String(url),
      method: init?.method ?? 'GET',
      key: (init?.headers as Record<string, string> | undefined)?.['X-API-KEY'] ?? null,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(body, { status });
  };
}

/** Nothing answers at all — the tunnel is down or the machine is off. The
 *  message deliberately QUOTES the address, which is what a real fetch
 *  implementation does and why the route strips it. */
function hostGone() {
  return async (url: string | URL | Request) => {
    CALLS.push({ url: String(url), method: 'POST', key: null, body: null });
    throw new TypeError(`request to ${URL_SECRET}/health failed, reason: ECONNREFUSED`);
  };
}

function appWith(perms: string[]) {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  /* Only the two fields the gate reads — the same fixture shape
     systemHealthRestCeiling.test.ts uses for this file's other admin routes. */
  app.use('*', async (c, next) => { c.set('user', { id: 1, permissions: perms }); await next(); });
  app.route('/', health);
  return app;
}

type HostBuildBody = {
  check: string; status: string; configured: boolean; verdict: string; meaning: string;
  hostStatus: number; latencyMs: number;
  builtAt: string | null; mvid: string | null; book: string | null; service: string | null;
  otherKeys: string[]; hostError: string | null; howToCompare: string; scopeNotes: string[];
};

async function ask(
  fetchImpl: ReturnType<typeof hostAnswering> | ReturnType<typeof hostGone>,
  env: Record<string, string> = ENV,
) {
  CALLS = [];
  vi.stubGlobal('fetch', fetchImpl);
  const res = await appWith(['*']).request('/autocount/host-build', undefined, env);
  return { res, body: (await res.json()) as HostBuildBody };
}

afterEach(() => { vi.unstubAllGlobals(); });

const LIVE = JSON.stringify({
  ok: true, book: 'AED_HOUZS', service: 'AcSyncService',
  builtAt: '2026-09-01T04:22:11Z', mvid: '6f0b6a0e-1d2f-4a51-9d0c-2f1b7c9a4e88',
});

describe('/autocount/host-build — which build is answering', () => {
  it('reports the build the host names, and calls it ok', async () => {
    const { res, body } = await ask(hostAnswering(200, LIVE));
    expect(res.status).toBe(200);
    expect(body.verdict).toBe('REPORTED');
    expect(body.status).toBe('ok');
    expect(body.builtAt).toBe('2026-09-01T04:22:11Z');
    expect(body.mvid).toBe('6f0b6a0e-1d2f-4a51-9d0c-2f1b7c9a4e88');
    expect(body.book).toBe('AED_HOUZS');
    expect(body.service).toBe('AcSyncService');
    expect(body.hostStatus).toBe(200);
    expect(body.hostError).toBeNull();
  });

  it('calls ONLY /health, and sends the key in the header where it belongs', async () => {
    await ask(hostAnswering(200, LIVE));
    expect(CALLS).toHaveLength(1);
    expect(CALLS[0].url).toBe(`${URL_SECRET}/health`);
    expect(CALLS[0].key).toBe(KEY_SECRET);
    // Read-only: the payload is empty, so nothing can be interpreted as a document.
    expect(CALLS[0].body).toBe('{}');
  });

  it('CATCHES an exe older than the build fields — the answer that used to be unreachable', async () => {
    // What a pre-2026-08-15 AcSyncService answers: ok, book, service, nothing else.
    const { body } = await ask(hostAnswering(200, JSON.stringify({ ok: true, book: 'AED_HOUZS', service: 'AcSyncService' })));
    expect(body.verdict).toBe('BUILD_NOT_REPORTED');
    expect(body.status).toBe('unknown');
    expect(body.builtAt).toBeNull();
    expect(body.mvid).toBeNull();
  });

  it('separates "sent no build keys" from "sent them as null"', async () => {
    // The C# sets both to null rather than omitting them when it cannot stat
    // itself — a NEW build that could not read its own file, not an old one.
    const { body } = await ask(hostAnswering(200, JSON.stringify({ ok: true, book: 'AED_HOUZS', builtAt: null, mvid: null })));
    expect(body.verdict).toBe('BUILD_UNREADABLE');
    expect(body.status).toBe('unknown');
  });

  it('still reports when only one of the two is readable', async () => {
    const { body } = await ask(hostAnswering(200, JSON.stringify({ ok: true, builtAt: null, mvid: 'abc-123' })));
    expect(body.verdict).toBe('REPORTED');
    expect(body.mvid).toBe('abc-123');
    expect(body.builtAt).toBeNull();
  });

  it('says the host REFUSED OUR KEY, which is not the host being down', async () => {
    const { body } = await ask(hostAnswering(401, JSON.stringify({ ok: false, error: 'bad key' })));
    expect(body.verdict).toBe('HOST_REFUSED_OUR_KEY');
    expect(body.hostStatus).toBe(401);
    expect(body.hostError).toBe('bad key');
    expect(body.meaning).toContain('running and refused us');
  });

  it('says the host has NO KEY FILE — its fail-closed 503, not a gateway 503', async () => {
    const { body } = await ask(hostAnswering(503, JSON.stringify({ ok: false, error: 'no API key configured on the host - refusing every request' })));
    expect(body.verdict).toBe('HOST_HAS_NO_KEY');
    expect(body.hostStatus).toBe(503);
  });

  it('does NOT call a stopped service a refusal — a gateway status with no JSON', async () => {
    // Cloudflare answers an unreachable origin with text/plain `error code: 502`.
    const { body } = await ask(hostAnswering(502, 'error code: 502'));
    expect(body.verdict).toBe('HOST_DID_NOT_ANSWER');
    expect(body.hostStatus).toBe(502);
    expect(body.meaning).toContain('Nothing reached the machine');
  });

  it('reports nothing-answered-at-all as the same job, with status 0', async () => {
    const { body } = await ask(hostGone());
    expect(body.verdict).toBe('HOST_DID_NOT_ANSWER');
    expect(body.hostStatus).toBe(0);
  });

  it('keeps an unexpected host status as its own answer rather than guessing', async () => {
    const { body } = await ask(hostAnswering(404, JSON.stringify({ ok: false, error: 'unknown route /health' })));
    expect(body.verdict).toBe('HOST_ERROR');
    expect(body.hostError).toBe('unknown route /health');
  });

  it('names a field a newer host sends without forwarding its value', async () => {
    const { body } = await ask(hostAnswering(200, JSON.stringify({ ok: true, builtAt: '2026-09-01T04:22:11Z', mvid: 'm', sqlServer: 'HOUZS-PC\\SQLEXPRESS' })));
    expect(body.otherKeys).toEqual(['sqlServer']);
    expect(JSON.stringify(body)).not.toContain('SQLEXPRESS');
  });

  it('answers 503 NOT_CONFIGURED when this Worker has no host to ask', async () => {
    const { res, body } = await ask(hostAnswering(200, LIVE), {});
    expect(res.status).toBe(503);
    expect(body.configured).toBe(false);
    expect(body.verdict).toBe('NOT_CONFIGURED');
    // Nothing was asked of anything.
    expect(CALLS).toHaveLength(0);
  });

  it('is gated on an admin capability, not on being logged in', async () => {
    vi.stubGlobal('fetch', hostAnswering(200, LIVE));
    const denied = await appWith(['scm.access']).request('/autocount/host-build', undefined, ENV);
    expect(denied.status).toBe(403);
  });

  it('never lets AC_SYNC_URL or AC_SYNC_KEY reach the response', async () => {
    // The transport error QUOTES the address, so this is the path that would
    // leak it if the strip were removed.
    const gone = await ask(hostGone());
    expect(JSON.stringify(gone.body)).not.toContain(URL_SECRET);
    expect(JSON.stringify(gone.body)).not.toContain(KEY_SECRET);
    expect(gone.body.hostError).toContain('[address removed]');

    const ok = await ask(hostAnswering(200, LIVE));
    expect(JSON.stringify(ok.body)).not.toContain(URL_SECRET);
    expect(JSON.stringify(ok.body)).not.toContain(KEY_SECRET);
  });
});

describe('stripUrls — the guard itself, not just its effect', () => {
  it('removes an address wherever it appears in a sentence', () => {
    expect(stripUrls('request to https://host.example/health failed')).toBe('request to [address removed] failed');
    expect(stripUrls('http://10.147.17.100:8900/health refused')).toBe('[address removed] refused');
  });

  it('leaves text carrying no address exactly as it was', () => {
    expect(stripUrls('no API key configured on the host - refusing every request'))
      .toBe('no API key configured on the host - refusing every request');
  });
});
