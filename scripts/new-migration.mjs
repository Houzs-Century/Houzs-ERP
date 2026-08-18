#!/usr/bin/env node
// Mint a migration filename that CANNOT collide with a parallel branch.
//
// A sequential number is only CLAIMED at merge but has to be CHOSEN at
// authoring time, so every branch open at once picks the same "next free" one
// and all but the first has to rename. On 2026-08-18, with ~10 PRs in flight,
// 0300 was taken twice inside thirty minutes.
//
// A UTC timestamp is chosen at authoring time and is already unique. It sorts
// after every numbered file ("2" > "0"), which is the order pg-migrate applies
// in — it reads the directory, sorts by filename, and keys its tracker on the
// full filename, so this format needs no runner change at all.
//
//   node scripts/new-migration.mjs scm_gl_views_composite_account_key
//   -> backend/src/db/migrations-pg/20260818T0345_scm_gl_views_composite_account_key.sql
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const slug = process.argv[2];
if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
  console.error('usage: node scripts/new-migration.mjs <lower_snake_case_slug>');
  process.exit(1);
}

const d = new Date();
const p = (n, w = 2) => String(n).padStart(w, '0');
const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;

const dir = path.join(process.cwd(), 'backend/src/db/migrations-pg');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${stamp}_${slug}.sql`);
if (existsSync(file)) {
  console.error(`${file} already exists — wait a minute and re-run, or pick another slug.`);
  process.exit(1);
}

writeFileSync(file, `-- ${stamp}_${slug}.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Reversal: <how it is undone, or why it cannot be>
-- Verified against: <the database or catalog it was proved on>
--
-- Both lines above are read by scripts/check-working-agreement.mjs from the PR
-- BODY, not from here — copy them across. Prefer CREATE OR REPLACE over DROP for
-- views: 0189 -> 0190 -> 0191 is the recorded case where a DROP lost the view's
-- grants and the API 403'd until they were re-issued.

`, 'utf8');
console.log(path.relative(process.cwd(), file));
