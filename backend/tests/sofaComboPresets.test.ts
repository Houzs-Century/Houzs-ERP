/* New combo presets (mig 20261112T1400; owner 2026-11-12: the hard-coded list
   becomes maintainable), on the real handlers over fake PostgREST:
     • list in order, add at the end, rename, change slots, switch off, reorder;
     • writes need the combo-pricing permission (scm.config.write);
     • company scope: company A neither sees nor edits company B's presets. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { sofaComboPresets, type ComboPreset } from '../src/scm/routes/sofa-combo-presets';

const A = 1;
const B = 2;

const seed = (): Row[] => [
  { id: 'a-1', company_id: A, name: 'L shape', slots: [['2A'], ['L']], sort_order: 0, active: true },
  { id: 'a-2', company_id: A, name: '2 + 1', slots: [['1S'], ['2S']], sort_order: 1, active: true },
  { id: 'b-1', company_id: B, name: 'B only', slots: [['CNR']], sort_order: 0, active: true },
];

function harness(opts: { company: number; canWrite: boolean }) {
  const sb = fakeSb({ sofa_combo_presets: seed() });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, opts.company as never);
    c.set('allowedCompanyIds' as never, [opts.company] as never);
    c.set('houzsUser' as never, { id: 7, permissions_set: new Set<string>(opts.canWrite ? ['scm.config.write'] : []) } as never);
    await next();
  });
  app.route('/sofa-combo-presets', sofaComboPresets as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, rows: (sb as unknown as { tables: Record<string, Row[]> }).tables.sofa_combo_presets };
}

const list = async (req: ReturnType<typeof harness>['req']) =>
  ((await (await req('/sofa-combo-presets', 'GET')).json()) as { presets: ComboPreset[] }).presets;

describe('combo presets', () => {
  test('the list is the company\'s presets, in order', async () => {
    const { req } = harness({ company: A, canWrite: false });
    expect((await list(req)).map((p) => [p.name, p.slots, p.active])).toEqual([
      ['L shape', [['2A'], ['L']], true],
      ['2 + 1', [['1S'], ['2S']], true],
    ]);
  });

  test('a new preset goes to the end, slots cleaned; a repeated name is refused', async () => {
    const { req } = harness({ company: A, canWrite: true });
    const res = await req('/sofa-combo-presets', 'POST', { name: 'Corner set', slots: [[' 2A ', '2A'], [], ['CNR'], ['1A(LHF)']] });
    expect(res.status).toBe(201);
    const { preset } = await res.json() as { preset: ComboPreset };
    expect(preset).toMatchObject({ name: 'Corner set', slots: [['2A'], ['CNR'], ['1A(LHF)']], sortOrder: 2, active: true });
    const dup = await req('/sofa-combo-presets', 'POST', { name: 'l SHAPE', slots: [['2A']] });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'name_taken' });
    expect((await req('/sofa-combo-presets', 'POST', { name: 'Empty', slots: [[]] })).status).toBe(400);
  });

  test('a preset is renamed, its slots changed, and switched off, never deleted', async () => {
    const { req, rows } = harness({ company: A, canWrite: true });
    const res = await req('/sofa-combo-presets/a-2', 'PATCH', { name: '1 + 2', slots: [['1S'], ['2S'], ['STOOL']] });
    expect(res.status).toBe(200);
    expect((await res.json() as { preset: ComboPreset }).preset).toMatchObject({ name: '1 + 2', slots: [['1S'], ['2S'], ['STOOL']] });
    expect((await req('/sofa-combo-presets/a-2', 'PATCH', { active: false })).status).toBe(200);
    expect(rows.find((r) => r.id === 'a-2')).toMatchObject({ active: false });
    expect((await list(req)).map((p) => [p.name, p.active])).toEqual([['L shape', true], ['1 + 2', false]]);
    expect((await req('/sofa-combo-presets/a-2', 'PATCH', { name: 'L Shape' })).status).toBe(409);
  });

  test('reorder sets the order of every preset; a stale list is refused', async () => {
    const { req } = harness({ company: A, canWrite: true });
    const res = await req('/sofa-combo-presets/reorder', 'POST', { ids: ['a-2', 'a-1'] });
    expect(res.status).toBe(200);
    expect((await res.json() as { presets: ComboPreset[] }).presets.map((p) => [p.id, p.sortOrder])).toEqual([['a-2', 0], ['a-1', 1]]);
    expect((await req('/sofa-combo-presets/reorder', 'POST', { ids: ['a-1'] })).status).toBe(409);
  });

  test('writes need the combo-pricing permission', async () => {
    const { req, rows } = harness({ company: A, canWrite: false });
    expect((await req('/sofa-combo-presets', 'POST', { name: 'X', slots: [['2A']] })).status).toBe(403);
    expect((await req('/sofa-combo-presets/a-1', 'PATCH', { active: false })).status).toBe(403);
    expect((await req('/sofa-combo-presets/reorder', 'POST', { ids: ['a-2', 'a-1'] })).status).toBe(403);
    expect(rows.find((r) => r.id === 'a-1')).toMatchObject({ active: true, sort_order: 0 });
  });
});

describe('company scope', () => {
  test('company A does not see company B\'s presets', async () => {
    const { req } = harness({ company: A, canWrite: true });
    expect((await list(req)).map((p) => p.id)).toEqual(['a-1', 'a-2']);
  });

  test('company A cannot edit, switch off or reorder company B\'s presets', async () => {
    const { req, rows } = harness({ company: A, canWrite: true });
    expect((await req('/sofa-combo-presets/b-1', 'PATCH', { name: 'Taken over', active: false })).status).toBe(404);
    expect((await req('/sofa-combo-presets/reorder', 'POST', { ids: ['b-1', 'a-1', 'a-2'] })).status).toBe(409);
    expect(rows.find((r) => r.id === 'b-1')).toMatchObject({ name: 'B only', active: true, sort_order: 0 });
  });

  test('a preset added by company A is stamped with A and invisible to B', async () => {
    const a = harness({ company: A, canWrite: true });
    await a.req('/sofa-combo-presets', 'POST', { name: 'Mine', slots: [['2A']] });
    expect(a.rows.find((r) => r.name === 'Mine')).toMatchObject({ company_id: A });
    const b = harness({ company: B, canWrite: true });
    expect((await list(b.req)).map((p) => p.name)).toEqual(['B only']);
  });
});
