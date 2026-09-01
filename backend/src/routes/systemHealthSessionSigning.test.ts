/* THE PLACEHOLDER MUST READ AS OFF.
 *
 * `/live` now reports whether signed sessions are switched on, because that one
 * secret decides whether every API request first pays for two joined
 * authorization reads (`getUserBySession` — a six-table join plus a four-branch
 * UNION) before the route body runs. Unset, cheap endpoints like /api/presence
 * and /api/branding carry that cost even though their own answers are cached.
 *
 * The failure this file exists to stop is the tempting simplification:
 * `configured: !!c.env.SESSION_SIGNING_KEY`. That reads TRUE for a short
 * placeholder — while `sessionSigningSecret` rejects anything under 16
 * characters, so at RUNTIME the feature is still off. The panel would then say
 * "On" for a system that is paying the full cost, which is worse than no panel:
 * it closes the question with the wrong answer.
 *
 * So the suite drives the endpoint across the three states that matter — unset,
 * too short, real — and asserts the reported flag matches what the auth
 * middleware would actually do. It also pins that the SECRET ITSELF never
 * appears in the response.
 */
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

/* Only what /live touches. The DB stub answers every probe with a row shaped
   loosely enough for the counts block; nothing here is under test except the
   one flag. */
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
  app.use('*', async (c, next) => { c.set('user', { id: 1, permissions: ['*'] }); await next(); });
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
    /* 15 characters — one under the floor `sessionSigningSecret` enforces. A
       truthiness test would call this On; the running system would not. */
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
