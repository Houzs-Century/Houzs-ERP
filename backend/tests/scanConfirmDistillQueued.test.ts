/* Gap review G19: the learning from a confirmed scan-so correction was cut off.

   POST /scan-so/samples/:id/confirm re-distils the rep's rules, the shared alias
   dictionary and the shared rules: three sequential Claude calls over up to
   50-80 sample pairs. They ran in waitUntil, which Cloudflare stops 30 s after
   the response, so the later calls were cut off and only the weekly cron caught
   up. They now go on SCAN_QUEUE, whose consumer has minutes. */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  not() { return this; }
  update(p: Row) { this.patch = p; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

let tables: Record<string, Row[]> = {};
const client = () => ({ from: (t: string) => new FakeQuery((tables[t] ||= [])) });

vi.mock('../src/db/supabase', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupabaseService: () => client(),
}));
vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../src/services/branding', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getBranding: async () => ({ companyName: 'Houzs' }),
}));

import { scanSo, processDistillQueueMessage } from '../src/scm/routes/scan-so';

function app() {
  tables = { so_scan_samples: [{ id: 'smp-1', status: 'EXTRACTED', salesperson: 'Ali', extracted: {}, corrected: null }] };
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('companyId' as never, 1 as never);
    c.set('houzsUser' as never, { id: 9 } as never);
    await next();
  });
  a.route('/', scanSo as never);
  return a;
}

const confirm = (env: Record<string, unknown>) => app().request('/samples/smp-1/confirm', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ corrected: { customerName: 'Tan' }, salesperson: 'Ali' }),
}, env);

afterEach(() => { vi.restoreAllMocks(); });

describe('confirmed correction learning rides SCAN_QUEUE (G19)', () => {
  test('confirm queues the distill and makes no Claude call itself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const send = vi.fn(async () => undefined);
    const res = await confirm({ SCAN_QUEUE: { send }, ANTHROPIC_API_KEY: 'k' });
    expect(res.status).toBe(200);
    expect(tables.so_scan_samples?.[0]?.status).not.toBe('EXTRACTED');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ distill: { rep: 'Ali', companyId: 1, userId: 9 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the consumer distils: a pool under 2 samples skips without a Claude call', async () => {
    tables = { so_scan_samples: [] };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await processDistillQueueMessage({ ANTHROPIC_API_KEY: 'k' } as never, { rep: 'Ali', companyId: 1, userId: 9 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the queue handler routes { distill } messages to the distiller and acks them', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(body && "distill" in body\) \{[\s\S]{0,200}processDistillQueueMessage\(env, body\.distill\)[\s\S]{0,200}msg\.ack\(\);/);
  });
});
