import { afterEach, describe, expect, test, vi } from 'vitest';
import { triggerMailSync } from '../src/lib/mail-sync-trigger';
import type { Env } from '../src/types';

afterEach(() => vi.unstubAllGlobals());

describe('triggerMailSync', () => {
  test('does nothing until the GitHub token is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await triggerMailSync({} as Env)).toEqual({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('asks GitHub to run mail-sync.yml on main', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await triggerMailSync({ GITHUB_TOKEN: 'tok' } as Env);
    expect(result).toEqual({ ok: true, status: 204 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/Houzs-Century/Houzs-ERP/actions/workflows/mail-sync.yml/dispatches');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'main' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  test('reports a refused dispatch instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad credentials', { status: 401 })));
    expect(await triggerMailSync({ GITHUB_TOKEN: 'bad' } as Env)).toEqual({ ok: false, status: 401 });
  });
});
