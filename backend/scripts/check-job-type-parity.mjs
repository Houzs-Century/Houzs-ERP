#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-job-type-parity.mjs — does the rate card still price every job we can
// dispatch, and is the code's copy of the job-type enum still true?
//
// WHY THIS EXISTS. Owner, 2026-08-02: "我的 job type 有什么类型，它就应该有什么
// 类型". The failure it guards is silent and expensive: someone adds a value to
// scm.trip_stop_type, nobody adds a way to charge for it, and the fleet does
// that work for free until an accountant notices. That is exactly what happened
// to SUPPLIER_PICKUP — dispatchable since mig 0128, one of only three types the
// New-DP-Order drawer offers, and unbillable until mig 0243.
//
// WHY A SCRIPT AND NOT A TEST. The backend suite runs in workerd
// (vitest-pool-workers), which has no filesystem, so a unit test can only check
// the code against ITSELF. rate-rule-taxonomy.test.ts does that half; this half
// reads the migrations and the source, so a stale constant cannot pass both.
//
// READ-ONLY. Touches no database and no network — it reads files.
//
//   node backend/scripts/check-job-type-parity.mjs      # exit 1 on drift
//   npm --prefix backend run audit:job-types
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const MIGRATIONS = join(BACKEND, 'src/db/migrations-pg');
const TAXONOMY = join(BACKEND, 'src/scm/lib/rate-rule-taxonomy.ts');
const FRONTEND_TAXONOMY = resolve(BACKEND, '../frontend/src/vendor/scm/lib/rate-rule-taxonomy.ts');

/** Every value on scm.trip_stop_type, assembled from the whole migration tree
 *  rather than a hand-listed set of files — a future ADD VALUE is picked up
 *  automatically, which is the entire point. */
function tripStopTypesFromMigrations() {
  const types = new Set();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const created = /CREATE TYPE scm\.trip_stop_type AS ENUM \(([^)]*)\)/.exec(sql);
    if (created) {
      for (const v of created[1].split(',')) {
        const t = v.trim().replace(/^'|'$/g, '');
        if (t) types.add(t);
      }
    }
    for (const m of sql.matchAll(/ALTER TYPE scm\.trip_stop_type\s+ADD VALUE(?: IF NOT EXISTS)? '([A-Z_]+)'/g)) {
      types.add(m[1]);
    }
  }
  return types;
}

/** The `NAME = [...] as const` array from the taxonomy source. */
function constArray(src, name) {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(src);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]));
}

/** The rule -> job-type map, including the explicit nulls. */
function ruleJobTypes(src) {
  const m = /export const RULE_JOB_TYPE: Record<RateRuleType, string \| null> = \{([\s\S]*?)\n\};/.exec(src);
  if (!m) return null;
  const out = new Map();
  for (const line of m[1].split('\n')) {
    const e = /^\s*([A-Z_]+):\s*(null|'([A-Z_]+)')/.exec(line);
    if (e) out.set(e[1], e[3] ?? null);
  }
  return out;
}

/** The rule_type CHECK from the newest migration that redefines it. */
function ruleTypesFromCheck() {
  let latest = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    if (!/delivery_rate_rules_rule_type_check|rule_type\s+TEXT NOT NULL CHECK/.test(sql)) continue;
    const body = /CHECK \(\s*rule_type IN \(([\s\S]*?)\)\s*\)/.exec(sql);
    if (body) latest = { file, types: new Set([...body[1].matchAll(/'([A-Z_]+)'/g)].map((m2) => m2[1])) };
  }
  return latest;
}

const problems = [];
const src = readFileSync(TAXONOMY, 'utf8');

const dbJobs = tripStopTypesFromMigrations();
const codeJobs = constArray(src, 'DISPATCHABLE_JOB_TYPES');
const ruleTypes = constArray(src, 'RATE_RULE_TYPES');
const jobOfRule = ruleJobTypes(src);
const check = ruleTypesFromCheck();

if (!codeJobs || !ruleTypes || !jobOfRule) {
  console.error('Could not parse rate-rule-taxonomy.ts — its shape changed. Fix this script, do not delete the check.');
  process.exit(1);
}
if (dbJobs.size === 0) {
  console.error('Found no scm.trip_stop_type values in the migration tree. The reader is broken, not the code.');
  process.exit(1);
}

// 1. The code's copy of the enum is still the enum.
for (const j of dbJobs) if (!codeJobs.has(j)) problems.push(`scm.trip_stop_type has '${j}', DISPATCHABLE_JOB_TYPES does not.`);
for (const j of codeJobs) if (!dbJobs.has(j)) problems.push(`DISPATCHABLE_JOB_TYPES has '${j}', scm.trip_stop_type does not.`);

/* 2. Every dispatchable job can be priced — unless the taxonomy names it as one
      we bill to nobody (NON_BILLABLE_JOB_TYPES, e.g. LORRY_SERVICE: the workshop
      bills US). The exemption list is READ FROM THE TAXONOMY, not repeated here,
      so the test in that folder and this script cannot grant different ones. An
      unparseable/absent list degrades to "no exemptions" — stricter, never
      looser. */
const exempt = constArray(src, 'NON_BILLABLE_JOB_TYPES') ?? new Set();
const priced = new Set([...jobOfRule.values()].filter(Boolean));
for (const j of dbJobs) {
  if (priced.has(j) || exempt.has(j)) continue;
  problems.push(`Job type '${j}' can be dispatched but NO rate rule prices it — that work would be done for free.`);
}
/* 2b. An exemption for a job type that no longer exists is a stale excuse, and
       one for a job that IS priced hides a real rule behind a "we don't bill
       this" note. Both mean the list was left behind by a schema change. */
for (const j of exempt) {
  if (!dbJobs.has(j)) problems.push(`NON_BILLABLE_JOB_TYPES exempts '${j}', which scm.trip_stop_type does not have.`);
  else if (priced.has(j)) problems.push(`NON_BILLABLE_JOB_TYPES says '${j}' is not billable, but a rate rule prices it. Drop the exemption or the rule.`);
}

// 3. No rule claims a job type that does not exist.
for (const [rule, job] of jobOfRule) {
  if (job && !dbJobs.has(job)) problems.push(`Rule '${rule}' claims job type '${job}', which scm.trip_stop_type does not have.`);
}

// 4. The CHECK and the code agree on the rule types.
if (check) {
  for (const t of check.types) if (!ruleTypes.has(t)) problems.push(`${check.file} allows rule_type '${t}', RATE_RULE_TYPES does not.`);
  for (const t of ruleTypes) if (!check.types.has(t)) problems.push(`RATE_RULE_TYPES has '${t}', but ${check.file}'s CHECK would reject it.`);
} else {
  problems.push('Could not find the delivery_rate_rules rule_type CHECK in any migration.');
}

// 5. The frontend mirror still says the same thing. A mirror with no check is
//    a copy waiting to lie — and this one drives what the operator sees when
//    they price a job.
try {
  const fe = readFileSync(FRONTEND_TAXONOMY, 'utf8');
  const feRules = constArray(fe, 'RATE_RULE_TYPES');
  const feCats = constArray(fe, 'RATE_RULE_CATEGORIES');
  const beCats = constArray(src, 'RATE_RULE_CATEGORIES');
  if (!feRules) {
    problems.push('Could not parse RATE_RULE_TYPES out of the frontend taxonomy mirror.');
  } else {
    for (const t of ruleTypes) if (!feRules.has(t)) problems.push(`Frontend taxonomy is missing rule type '${t}'.`);
    for (const t of feRules) if (!ruleTypes.has(t)) problems.push(`Frontend taxonomy has rule type '${t}', the backend does not.`);
  }
  if (feCats && beCats) {
    for (const cat of beCats) if (!feCats.has(cat)) problems.push(`Frontend taxonomy is missing category '${cat}'.`);
    for (const cat of feCats) if (!beCats.has(cat)) problems.push(`Frontend taxonomy has category '${cat}', the backend does not.`);
  }
  /* The category ASSIGNMENT matters as much as the list: a rule filed under
     Delivery on one side and Service calls on the other puts it in a different
     place on screen than in any report. */
  const beMap = /export const RULE_CATEGORY: Record<RateRuleType, RateRuleCategory> = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
  const feMap = /export const RULE_CATEGORY: Record<RateRuleTypeT, RateRuleCategory> = \{([\s\S]*?)\n\};/.exec(fe)?.[1] ?? '';
  const pairs = (body) => new Map([...body.matchAll(/^\s*([A-Z_]+):\s*'([A-Z_]+)'/gm)].map((m) => [m[1], m[2]]));
  const bePairs = pairs(beMap); const fePairs = pairs(feMap);
  for (const [rule, cat] of bePairs) {
    const other = fePairs.get(rule);
    if (other !== cat) problems.push(`Rule '${rule}' is '${cat}' in the backend but '${other ?? 'absent'}' in the frontend.`);
  }
} catch (err) {
  problems.push(`Could not read the frontend taxonomy mirror: ${err.message}`);
}

if (problems.length > 0) {
  console.error('\nJob type / rate rule parity has DRIFTED:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEither add the missing rule type (a migration extending the CHECK + the taxonomy map),');
  console.error('or record the omission deliberately by mapping the rule to null with the reason.\n');
  process.exit(1);
}

console.log(`Job type / rate rule parity is current — ${dbJobs.size} dispatchable job type(s), ${ruleTypes.size} rule type(s), all priced.`);
