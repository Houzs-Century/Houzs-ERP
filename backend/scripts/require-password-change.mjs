#!/usr/bin/env node
/* Require admins and finance staff to choose a new password, and end every
   session they hold.

   WHY. docs/staging-dump-artifact-exposure-coe.md: staff password HASHES were in
   public CI artifacts. A hash is not the password, but a weak password can be
   recovered from one offline. The owner approved (2026-11-10) forcing at least
   admins and finance staff onto a new password.

   WHO. scripts/lib/password-change-population.mjs decides, from the permission
   model the app enforces: wildcard role, god Title, users.manage, roles.manage
   (admin); finance duty, money Title, a money-moving key (finance). Active
   members with a password only. EXCLUDE_USER_IDS=1,2 leaves named ids out.

   WHAT A FLAGGED MEMBER SEES. Their sessions end now. At the next email +
   password sign-in, a correct password opens only a "Choose a new password"
   screen; after saving they carry on as normal. Crew PIN and POS PIN sign-in
   are not affected.

   MODE=plan (default) reads and prints COUNTS ONLY — never an email or a name;
   the run log of a public repo is public.
   MODE=apply needs CONFIRM="REQUIRE NEW PASSWORDS". In one transaction it sets
   users.password_change_required_at, deletes the members' sessions and writes
   one audit_events row per member tagged with BATCH. Then, when
   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID are present, it writes the
   per-user revocation marker the Worker's signed-pass check reads
   (sess:revoked-uid:<id>, services/session-revocation.ts), so a pass already
   issued stops working too; without them, or if that write fails, such a pass
   stays usable until it expires (at most 8 hours) and the run says so.
   Finally it re-reads on a FRESH connection and asserts every member's flag is
   a timestamptz and no ordinary session survives.

   RE-RUN: skips every member already carrying an audit row for this BATCH, so a
   member who has since changed their password is NOT flagged again. Members who
   entered scope after the first run are flagged. Use a new BATCH value only to
   deliberately force everyone in scope again. */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { selectPopulation, summarise } from './lib/password-change-population.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REQUIRE NEW PASSWORDS';
const BATCH = (process.env.BATCH || 'staging-dump-artifact-exposure-2026-11').trim();
const AUDIT_ACTION = 'user.require_password_change';
const PASS_REVOKE_TTL_SECONDS = 9 * 60 * 60;
const excluded = new Set(
  String(process.env.EXCLUDE_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const members = await sql`
  SELECT u.id, u.status,
         (u.password_hash IS NOT NULL AND u.password_hash <> '') AS has_password,
         u.password_change_required_at IS NOT NULL AS already_flagged,
         r.permissions AS role_permissions,
         p.name AS position_name,
         (pp.position_id IS NOT NULL) AS has_policy_row,
         pp.cohort AS policy_cohort, pp.duty AS policy_duty, pp.can_move_money AS policy_money
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN positions p ON p.id = u.position_id
    LEFT JOIN position_policy pp ON pp.position_id = u.position_id`;

const inScope = selectPopulation(members);
const population = inScope.filter((p) => !excluded.has(p.id));
const ids = population.map((p) => p.id);

const done = ids.length
  ? new Set((await sql`
      SELECT DISTINCT entity_id FROM audit_events
       WHERE action = ${AUDIT_ACTION} AND entity_type = 'user'
         AND position(${`"batch":${JSON.stringify(BATCH)}`} in COALESCE(meta, '')) > 0
         AND entity_id = ANY(${ids.map(String)})`).map((r) => Number(r.entity_id)))
  : new Set();
const todo = ids.filter((id) => !done.has(id));

const sessions = todo.length
  ? (await sql`
      SELECT COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS members
        FROM sessions WHERE user_id = ANY(${todo})`)[0]
  : { n: 0, members: 0 };
const alreadyFlagged = members.filter((m) => m.already_flagged && todo.includes(m.id)).length;

const s = summarise(population);
console.log(`mode: ${APPLY ? 'apply' : 'plan'}   batch: ${BATCH}`);
console.log(`members read: ${members.length} (active with a password: ${members.filter((m) => m.status === 'active' && m.has_password).length})`);
console.log(`in scope: ${inScope.length}   excluded by EXCLUDE_USER_IDS: ${inScope.length - population.length}`);
console.log(`population: ${s.total}   admin: ${s.admin}   finance: ${s.finance}   both: ${s.both}`);
console.log(`by reason (a member can carry several): ${JSON.stringify(s.reasons)}`);
console.log(`already done in this batch: ${done.size}   to flag now: ${todo.length} (already flagged by an admin: ${alreadyFlagged})`);
console.log(`sessions that would end: ${sessions.n} across ${sessions.members} member(s)`);

if (!APPLY || todo.length === 0) {
  if (!APPLY) console.log('\nplan only: nothing was written. Re-run with MODE=apply and the CONFIRM phrase to act.');
  else console.log('\nnothing to do.');
  await sql.end({ timeout: 5 });
  process.exit(0);
}

const ended = await sql.begin(async (tx) => {
  await tx`UPDATE users SET password_change_required_at = COALESCE(password_change_required_at, now())
            WHERE id = ANY(${todo})`;
  const del = await tx`DELETE FROM sessions WHERE user_id = ANY(${todo})`;
  for (const id of todo) {
    await tx`
      INSERT INTO audit_events (actor_id, actor_email, action, entity_type, entity_id, summary, meta)
      VALUES (NULL, 'script:require-password-change', ${AUDIT_ACTION}, 'user', ${String(id)},
              ${`Required a new password at next sign-in (batch ${BATCH})`},
              ${JSON.stringify({ batch: BATCH, source: 'scripts/require-password-change.mjs' })})`;
  }
  return del.count;
});
await sql.end({ timeout: 5 });
console.log(`\nwrote: flagged ${todo.length} member(s), ended ${ended} session(s), ${todo.length} audit row(s)`);

async function revokeSignedPasses(userIds) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return 'skipped: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const toml = readFileSync(path.join(here, '..', 'wrangler.toml'), 'utf8');
  const prodPart = toml.split(/^\[env\./m)[0];
  const ns = prodPart.match(/binding\s*=\s*"SESSION_CACHE"\s*\n\s*id\s*=\s*"([0-9a-f]+)"/)?.[1];
  if (!ns) return 'skipped: production SESSION_CACHE id not found in wrangler.toml';
  const now = String(Date.now());
  const body = userIds.map((id) => ({ key: `sess:revoked-uid:${id}`, value: now, expiration_ttl: PASS_REVOKE_TTL_SECONDS }));
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/bulk`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok && j.success !== false ? `ok: ${userIds.length} revocation marker(s) written` : `FAILED: HTTP ${res.status}`;
  } catch (e) {
    return `FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const revoke = await revokeSignedPasses(todo);
console.log(`signed-pass revocation: ${revoke}`);
if (!revoke.startsWith('ok')) {
  console.log('  -> a signed pass already issued to these members stays usable until it expires (at most 8 hours).');
}

// Fresh connection: the one that wrote is the worst witness that the write landed.
const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const shape = await check`
  SELECT u.id, pg_typeof(u.password_change_required_at)::text AS flag_type,
         u.password_change_required_at IS NOT NULL AS flagged,
         (SELECT COUNT(*)::int FROM sessions s
           WHERE s.user_id = u.id AND s.origin IS DISTINCT FROM 'password_change') AS ordinary_sessions
    FROM users u WHERE u.id = ANY(${todo})`;
await check.end({ timeout: 5 });
const bad = shape.filter((r) => !r.flagged || r.flag_type !== 'timestamp with time zone' || r.ordinary_sessions > 0);
console.log(`verify (fresh connection): ${shape.length} member(s) re-read, ${bad.length} not in the expected shape`);
if (bad.length || shape.length !== todo.length) {
  console.error(`VERIFY FAILED for user id(s): ${bad.map((r) => r.id).join(', ') || '(row count mismatch)'}`);
  process.exit(1);
}
console.log('verified: every member is flagged (timestamptz) and holds no ordinary session.');
