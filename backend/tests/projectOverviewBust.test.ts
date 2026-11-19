/* A change made on a project shows on Project Overview at once (owner
   2026-11-19: 我里面edit过了 外面没有跟着换): a successful write under the
   project routes drops the company's cached overview; a read, a refused write
   or another company's copy is left alone. */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bustProjectOverviewOnWrite, isSuccessfulWrite, projectOverviewPrefix } from '../src/routes/lib/project-overview-bust';

function fakeKv(keys: string[]) {
  const store = new Set(keys);
  return {
    store,
    async list({ prefix }: { prefix: string }) { return { keys: [...store].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    async delete(k: string) { store.delete(k); },
  };
}

function app(kv: ReturnType<typeof fakeKv>) {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('companyId' as never, 1 as never); await next(); });
  a.use('/api/projects/*', bustProjectOverviewOnWrite);
  a.get('/api/projects/:id', (c) => c.json({ ok: true }));
  a.patch('/api/projects/:id', (c) => c.json({ ok: true }));
  a.post('/api/projects/refused', (c) => c.json({ error: 'no' }, 400));
  return { a, env: { SESSION_CACHE: kv } };
}

const KEYS = ['swr:projov:v1:1:2026-11-19', 'swr:projov:v1:2:2026-11-19', 'swr:procov:v1:1:x'];

describe('Project Overview cache after a project write', () => {
  it('a successful write drops this company overview copy only', async () => {
    const kv = fakeKv(KEYS);
    const { a, env } = app(kv);
    expect((await a.request('/api/projects/7', { method: 'PATCH' }, env)).status).toBe(200);
    expect([...kv.store]).toEqual(['swr:projov:v1:2:2026-11-19', 'swr:procov:v1:1:x']);
  });

  it('a read or a refused write keeps it', async () => {
    const kv = fakeKv(KEYS);
    const { a, env } = app(kv);
    await a.request('/api/projects/7', {}, env);
    await a.request('/api/projects/refused', { method: 'POST' }, env);
    expect([...kv.store]).toEqual(KEYS);
  });

  it('the rule and the key', () => {
    expect(isSuccessfulWrite('PUT', 200)).toBe(true);
    expect(isSuccessfulWrite('DELETE', 204)).toBe(true);
    expect(isSuccessfulWrite('GET', 200)).toBe(false);
    expect(isSuccessfulWrite('POST', 409)).toBe(false);
    expect(projectOverviewPrefix(3)).toBe('swr:projov:v1:3:');
  });
});
