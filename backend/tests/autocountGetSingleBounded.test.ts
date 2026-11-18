import { afterEach, describe, expect, test, vi } from 'vitest';
import { AutoCountClient, GET_SINGLE_TIMEOUT_MS } from '../src/services/autocount';

/* CI 2026-11-17: creating a service case awaits the AutoCount single-SO lookup,
   and an office host that never answered held the create open past the 60 s
   test limit. The lookup now carries an abort deadline; the case is created
   from what the ERP holds when it fires. */
afterEach(() => vi.unstubAllGlobals());

describe('AutoCountClient.getSingle is bounded', () => {
  test('the request carries an abort signal and a short deadline', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, i?: RequestInit) => { init = i; return new Response('[]'); }));
    const client = new AutoCountClient({ AUTOCOUNT_API_URL: 'https://example.invalid/', AUTOCOUNT_API_KEY: 'k' } as never);
    expect(await client.getSingle('SO-1')).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(GET_SINGLE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  test('a host that never answers rejects once the deadline passes', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: unknown, i?: RequestInit) => new Promise((_res, rej) => {
      i?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })));
    const client = new AutoCountClient({ AUTOCOUNT_API_URL: 'https://example.invalid/', AUTOCOUNT_API_KEY: 'k' } as never);
    const t0 = Date.now();
    await expect(client.getSingle('SO-2')).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(GET_SINGLE_TIMEOUT_MS + 3_000);
  }, 20_000);
});
