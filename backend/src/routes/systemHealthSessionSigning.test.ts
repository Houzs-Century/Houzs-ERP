import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db/supabase', () => ({
  getSupabaseService: () => ({
    from: () => ({
      select: () => ({ limit: () => Promise.resolve({ data: [], count: 0, error: null }) }),
    }),
  }),
  isSupabaseConfigured: () => false,
}));

const health = (await import('./systemHealth')).default;

function fakeEnv(signingKey: string | undefined) {
  const stmt = {
    bind: () => stmt,
    first: async () => ({ ok: 1, n: 0 }),
    all: async () => ({ results: [] }),
  };
  return {
    DB: { prepare: () => stmt },
    SESSION_CACHE: { get: async () => null },
    SO_ITEM_PHOTOS: { head: async () => null },
    ...(signingKey === undefined ? {} : { SESSION_SIGNING_KEY: signingKey }),
  } as unknown as Record<string, unknown>;
}

type LiveBody = {
  sessionSigning?: { configured: boolean };
  anthropic?: { configured: boolean };
};

async function live(signingKey: string | undefined) {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  app.use('*', async (c, next) => { c.set('user', { id: 1, permissions: ['it.view'] }); await next(); });
  app.route('/', health);
  const res = await app.request('/live', {}, fakeEnv(signingKey));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as LiveBody, text };
}

describe('/live — signed sessions are reported the way the middleware reads them', () => {
  it('reports OFF when the secret is absent', async () => {
    const { body } = await live(undefined);
    expect(body.sessionSigning).toEqual({ configured: false });
  });

  it('reports OFF for a placeholder too short to sign with', async () => {
    const { body } = await live('x'.repeat(15));
    expect(body.sessionSigning).toEqual({ configured: false });
  });

  it('reports ON for a key the signer would actually accept', async () => {
    const { body } = await live('x'.repeat(16));
    expect(body.sessionSigning).toEqual({ configured: true });
  });

  it('never puts the secret in the response', async () => {
    const secret = 'a-real-looking-signing-key-value';
    const { text } = await live(secret);
    expect(text).not.toContain(secret);
  });
});
