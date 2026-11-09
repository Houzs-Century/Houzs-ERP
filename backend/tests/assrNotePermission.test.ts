import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';

interface TestCaller {
  id: number;
  position_name: string;
  permissions_set: Set<string>;
}

const unscopedCallerWith = (permission: string): TestCaller => ({
  id: 1,
  position_name: 'Super Admin',
  permissions_set: new Set([permission]),
});

const mountAs = (caller: TestCaller): Hono => {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    c.set('user' as never, caller as never);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
};

const postEmptyNoteAs = async (caller: TestCaller): Promise<Response> =>
  mountAs(caller).request(
    '/1/notes',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '   ' }),
    },
    env,
  );

describe('POST /:id/notes permission', () => {
  test('staff who can only log cases pass the permission gate', async () => {
    const response = await postEmptyNoteAs(unscopedCallerWith('service_cases.create'));
    expect(response.status).toBe(400);
  });

  test('a read-only caller is still refused', async () => {
    const response = await postEmptyNoteAs(unscopedCallerWith('service_cases.read'));
    expect(response.status).toBe(403);
  });
});
