#!/usr/bin/env node
// check-areas-migration.mjs — production trial of mig 20261111T1000 (rate card
// areas), ROLLED BACK. Applies the migration twice in one transaction (it must be
// idempotent), proves its shape — an area on a real card, a rule naming it, one
// name per card, removing the area removes its rules, the grants, RLS on — then
// rolls everything back. Prints yes/no and counts only (public logs).
// Env: DATABASE_URL. mode=plan only.
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('trial only: run it with mode=plan.'); process.exit(1); }
const FILE = 'src/db/migrations-pg/20261111T1000_scm_delivery_rate_areas.sql';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const say = (k, v) => console.log(`CHECK|${k}|${v}`);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const [b] = await tx`
      SELECT to_regclass('scm.delivery_rate_areas') IS NOT NULL AS t,
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'scm' AND table_name = 'delivery_rate_rules' AND column_name = 'area_id') AS c`;
    say('before: areas table exists', b.t ? 'yes' : 'no');
    say('before: rules.area_id exists', b.c ? 'yes' : 'no');
    const text = readFileSync(FILE, 'utf8');
    await tx.unsafe(text);
    say('migration applied', 'yes');
    await tx.unsafe(text);
    say('applied again (idempotent)', 'yes');

    const [rls] = await tx`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'scm.delivery_rate_areas'::regclass`;
    say('RLS on', rls.on ? 'yes' : 'NO');
    const grants = await tx`
      SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
        FROM information_schema.role_table_grants
       WHERE table_schema = 'scm' AND table_name = 'delivery_rate_areas'
       GROUP BY grantee ORDER BY grantee`;
    for (const g of grants) say(`grant ${g.grantee}`, g.p);

    const [counts] = await tx`SELECT count(*)::int AS n, count(area_id)::int AS with_area FROM scm.delivery_rate_rules`;
    say('existing rules', `${counts.n} rules, ${counts.with_area} with an area`);
    const [cardCount] = await tx`SELECT count(*)::int AS n FROM scm.delivery_rate_cards`;
    say('existing cards', cardCount.n);

    const card = await tx`SELECT id, company_id FROM scm.delivery_rate_cards ORDER BY created_at LIMIT 1`;
    if (card.length === 0) { say('shape test', 'skipped: no card'); throw new Rollback(); }
    const { id: cardId, company_id: co } = card[0];
    const [a] = await tx`
      INSERT INTO scm.delivery_rate_areas (company_id, card_id, name, towns)
      VALUES (${co}, ${cardId}, 'ZZ TRIAL AREA', ${['ZZTOWN', 'ZZ OTHER TOWN']}) RETURNING id, towns`;
    say('area insert, towns kept', a.towns.length === 2 ? 'yes' : 'NO');
    const [r] = await tx`
      INSERT INTO scm.delivery_rate_rules (company_id, card_id, rule_type, tier_position, amount_sen, area_id)
      VALUES (${co}, ${cardId}, 'POSITIONAL_TIER', 1, 1, ${a.id}) RETURNING id`;
    say('rule naming the area', 'yes');

    let dup = 'NOT refused';
    try {
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO scm.delivery_rate_areas (company_id, card_id, name) VALUES (${co}, ${cardId}, 'ZZ TRIAL AREA')`;
      });
    } catch (e) { dup = e.code === '23505' ? 'refused (23505)' : `other error ${e.code}`; }
    say('same name twice on one card', dup);

    let badArea = 'NOT refused';
    try {
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO scm.delivery_rate_rules (company_id, card_id, rule_type, tier_position, amount_sen, area_id)
                 VALUES (${co}, ${cardId}, 'POSITIONAL_TIER', 1, 1, gen_random_uuid())`;
      });
    } catch (e) { badArea = e.code === '23503' ? 'refused (23503)' : `other error ${e.code}`; }
    say('rule naming a missing area', badArea);

    await tx`DELETE FROM scm.delivery_rate_areas WHERE id = ${a.id}`;
    const [left] = await tx`SELECT count(*)::int AS n FROM scm.delivery_rate_rules WHERE id = ${r.id}`;
    say('removing the area removes its rules', left.n === 0 ? 'yes' : 'NO');
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) console.log('Rolled back: nothing was written.');
  else { console.error(`FAILED: ${e.message}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
