/* A machine that did not answer must not be reported as a data problem.
 *
 * Owner, 2026-08-23: 「所以是什么问题进不去」 — asked repeatedly, because the
 * screen kept answering with the wrong thing.
 *
 * WHAT THE OPERATOR SAW, on every stuck document:
 *
 *   masters not opened, document not sent: error code: 502
 *
 * WHAT WAS TRUE: the request never reached the machine. `error code: 502` is
 * Cloudflare's plain-text body for an origin it cannot reach — 16 bytes,
 * `content-type: text/plain`, `server: cloudflare`, answered in 0.06s.
 * Reproduced from outside the ERP entirely:
 *
 *   $ curl -i https://autocount.houzscentury.com/health
 *   HTTP/2 502 … error code: 502
 *
 * It said "masters not opened" because callAcService pasted the RAW BODY into
 * the error string whenever the response was not JSON, and the masters step is
 * simply the first call made. The ERP had asked AutoCount to open nothing.
 *
 * THE COST OF THE WRONG SENTENCE, and why this is a test and not a comment: a
 * day was spent looking at AutoCount logins and master data for a fault that was
 * a stopped Windows service. A message that names the wrong subsystem does not
 * merely fail to help — it actively sends the investigation somewhere else.
 *
 * Both directions are pinned. A REAL masters failure still says so: the service
 * answering with its own JSON `error` is AutoCount speaking, and it keeps its
 * own words.
 */
import { describe, expect, it } from 'vitest';

import { classifyAcSkip } from './autocount-outbox-status';
import { callAcService } from '../../services/autocount-writeback';

const env = { AC_SYNC_URL: 'https://autocount.example', AC_SYNC_KEY: 'k' } as never;

const cloudflare502 = async () =>
  new Response('error code: 502', { status: 502, headers: { 'content-type': 'text/plain' } });

const serviceRefusal = async () =>
  new Response(JSON.stringify({ ok: false, error: 'masters not opened: item 9028 unknown' }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });

describe('callAcService — a gateway status with a non-JSON body', () => {
  it('says the host did not answer, not that anything was refused', async () => {
    const r = await callAcService(env, 'ensure_masters', {}, cloudflare502 as never);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('did not answer');
    expect(r.error).toContain('never reached it');
  });

  it('does NOT leak the raw transport body as the whole explanation', async () => {
    const r = await callAcService(env, 'ensure_masters', {}, cloudflare502 as never);
    expect(r.error).not.toBe('error code: 502');
  });

  it('names the check that settles it, so nobody has to guess again', async () => {
    const r = await callAcService(env, 'ensure_masters', {}, cloudflare502 as never);
    expect(r.error).toContain('/health');
  });

  it('stays retryable — a stopped service is a transient state', async () => {
    const r = await callAcService(env, 'ensure_masters', {}, cloudflare502 as never);
    expect(r.retryable).toBe(true);
  });

  it('a JSON error from the service is NOT rewritten', async () => {
    const r = await callAcService(env, 'ensure_masters', {}, serviceRefusal as never);
    expect(r.error).toBe('masters not opened: item 9028 unknown');
  });
});

describe('classifyAcSkip — the operator gets the right subsystem', () => {
  it('an unreachable host is its own kind, not a masters problem', () => {
    const stored = 'masters not opened, document not sent: the AutoCount host did not answer (HTTP 502) — the request never reached it';
    expect(classifyAcSkip(stored).kind).toBe('host-unreachable');
  });

  it('wins over the masters needle even though both appear in the text', () => {
    const stored = 'masters not opened, document not sent: the AutoCount host did not answer (HTTP 503)';
    expect(classifyAcSkip(stored).kind).not.toBe('masters-not-opened');
  });

  it('a genuine masters failure is still a masters failure', () => {
    const stored = 'masters not opened, document not sent: item 9028 unknown';
    expect(classifyAcSkip(stored).kind).toBe('masters-not-opened');
  });
});
