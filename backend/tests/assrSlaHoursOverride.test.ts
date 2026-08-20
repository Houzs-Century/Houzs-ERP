import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import assrApp from '../src/routes/assr';
import { patchAssrCase, slaHoursFor, slaHoursForPriority } from '../src/services/assr';

/* Service Maintenance offers an "SLA Hours" cell on each priority
   (ServiceSettings.tsx, "SLA window in hours; blank = use module default"),
   routes/assr.ts saves it, and mig 065 calls the column an "optional override
   of slaHoursFor()". Until 2026-08-20 nothing ever READ it: both SLA
   computations called slaHoursFor(), which only ever consulted the hardcoded
   SLA_HOURS_BY_PRIORITY. The seeded rows happen to equal the constant, so the
   field looked fine right up until a manager edited it — at which point the
   edit saved, reported success, and changed nothing.

   These tests were run RED before being trusted, in two separate reverts:
     - putting `slaHoursFor` back at the two call sites fails 2 of 6 (the two
       that assert an edited window reaches a case);
     - deleting the `normalizeSlaHours` branch from PATCH fails 1 of 6.
   The other three hold on both sides on purpose — they pin the fallback, the
   resolver, and the CHECK constraint noted below, none of which this fix
   changes. */

const CREATOR = {
  id: 1,
  permissions_set: new Set([
    'service_cases.create',
    'service_cases.write',
    'service_cases.manage',
  ]),
} as any;

function mount() {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    (c as any).set('user', CREATOR);
    await next();
  });
  parent.route('/', assrApp);
  return parent;
}

async function setSlaHours(slug: string, hours: number | null) {
  await env.DB.prepare(`UPDATE assr_priorities SET sla_hours = ? WHERE slug = ?`)
    .bind(hours, slug)
    .run();
}

async function createCase(priority: string, docNo: string) {
  const res = await mount().request(
    '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc_no: docNo,
        items: [{ item_code: 'ITM-1' }],
        complaint_issue: 'Sagging',
        issue_category: 'Product Defect',
        priority,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: number };
  return json.id;
}

async function readCase(id: number) {
  return env.DB.prepare(
    `SELECT sla_hours, deadline_at, created_at FROM assr_cases WHERE id = ?`,
  )
    .bind(id)
    .first<{ sla_hours: number | null; deadline_at: string; created_at: string }>();
}

/** Hours between two ISO timestamps, rounded — the deadline is derived from
 *  `Date.now()` at create, so an exact equality would be flaky. */
function hoursBetween(fromIso: string, toIso: string) {
  return Math.round(
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000,
  );
}

describe('the SLA Hours cell a manager edits is the one the case uses', () => {
  beforeEach(async () => {
    // Restore the mig 065 seed so each test starts from the documented state.
    await env.DB.prepare(
      `UPDATE assr_priorities SET sla_hours = CASE slug
         WHEN 'low' THEN 336 WHEN 'normal' THEN 168
         WHEN 'high' THEN 72 WHEN 'urgent' THEN 24 END
       WHERE slug IN ('low','normal','high','urgent')`,
    ).run();
    await env.DB.prepare(`DELETE FROM assr_priorities WHERE slug = 'critical'`).run();
  });

  test('an edited window drives the new case, not the hardcoded constant', async () => {
    await setSlaHours('high', 5);
    const before = Date.now();
    const id = await createCase('high', 'SO-SLA-1');
    const row = await readCase(id);

    expect(row?.sla_hours).toBe(5);
    expect(slaHoursFor('high')).toBe(72); // the constant is untouched
    const deltaH = Math.round((new Date(row!.deadline_at).getTime() - before) / 3_600_000);
    expect(deltaH).toBe(5);
  });

  test('a blank cell means "use the module default" — as the UI promises', async () => {
    await setSlaHours('low', null);
    const id = await createCase('low', 'SO-SLA-2');
    expect((await readCase(id))?.sla_hours).toBe(slaHoursFor('low')); // 336
  });

  test('the resolver reads any slug, including one a manager added', async () => {
    const res = await mount().request(
      '/lookups/priorities',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Critical', slug: 'critical', sla_hours: 6 }),
      },
      env,
    );
    expect(res.status).toBe(200);

    // The constant knows only low/normal/high/urgent, so a custom slug used to
    // resolve to 168 no matter what was typed.
    expect(slaHoursFor('critical')).toBe(168);
    expect(await slaHoursForPriority(env, 'critical')).toBe(6);

    // ...but it still cannot reach a CASE. `assr_cases.priority` carries
    // `CHECK (priority IN ('low','normal','high','urgent'))`
    // (migrations/010_assr_redesign.sql:16, re-stated by 074:93), so Service
    // Maintenance can ADD a priority, save it, list it — and every case create
    // using it fails. That is a SECOND defect of this same shape, deliberately
    // NOT fixed here: widening a CHECK is a schema decision with its own
    // migration, and this PR must not weaken a constraint as a side effect.
    // Pinned so the day someone widens it, this note is what they read.
    const row = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assr_cases'`,
    ).first<{ sql: string }>();
    expect(row?.sql).toContain("priority IN ('low','normal','high','urgent')");
  });

  test('changing a case priority recomputes the deadline off the edited window', async () => {
    const id = await createCase('normal', 'SO-SLA-4');
    await setSlaHours('urgent', 3);

    expect(await patchAssrCase(env, id, { priority: 'urgent' }, 1)).toBe(true);
    const row = await readCase(id);
    expect(row?.sla_hours).toBe(3);
    // PATCH recomputes off created_at, not off now.
    expect(hoursBetween(row!.created_at, row!.deadline_at)).toBe(3);
  });
});

describe('the cell refuses junk instead of storing it', () => {
  test('PATCH rejects a non-positive / non-integer window and stores nothing', async () => {
    await setSlaHours('high', 72);
    const row = await env.DB.prepare(
      `SELECT id FROM assr_priorities WHERE slug = 'high'`,
    ).first<{ id: number }>();

    for (const bad of [0, -5, 'abc', 1.5]) {
      const res = await mount().request(
        `/lookups/priorities/${row!.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sla_hours: bad }),
        },
        env,
      );
      expect(res.status).toBe(400);
    }

    const after = await env.DB.prepare(
      `SELECT sla_hours FROM assr_priorities WHERE slug = 'high'`,
    ).first<{ sla_hours: number | null }>();
    expect(after?.sla_hours).toBe(72);
  });

  test('PATCH accepts blank as "use the module default"', async () => {
    const row = await env.DB.prepare(
      `SELECT id FROM assr_priorities WHERE slug = 'high'`,
    ).first<{ id: number }>();
    const res = await mount().request(
      `/lookups/priorities/${row!.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sla_hours: null }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const after = await env.DB.prepare(
      `SELECT sla_hours FROM assr_priorities WHERE slug = 'high'`,
    ).first<{ sla_hours: number | null }>();
    expect(after?.sla_hours).toBe(null);
  });
});
