#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-work-order-states.mjs — do the three copies of the work-order state
// list still agree?
//
// WHY THIS EXISTS. The list lives in THREE places by necessity:
//   1. backend/src/services/fleet-status.ts — the state machine itself.
//   2. the migration CHECK on scm.lorry_work_orders.status — the database's
//      refusal, which is the only one that stops a bad write.
//   3. frontend/src/pages/FleetHealth.tsx — the stepper, which needs the ORDER;
//      the API sends a status and its label, never the sequence.
//
// Adding QUOTED (mig 0247) meant editing all three by hand, and the failure
// modes are each silent in their own way: miss the CHECK and every transition
// into the new state 500s; miss the frontend and the stepper renders a work
// order whose status is not on its own rail, so `indexOf` returns -1 and every
// step draws as un-reached.
//
// WHY A SCRIPT AND NOT A TEST. The backend suite runs in workerd
// (vitest-pool-workers), which has no filesystem — a unit test can only compare
// code to code. This reads the migration tree and the frontend source, so a
// stale copy cannot pass both.
//
// READ-ONLY. Touches no database and no network — it reads files.
//
//   node backend/scripts/check-work-order-states.mjs    # exit 1 on drift
//   npm --prefix backend run audit:work-order-states
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const MIGRATIONS = join(BACKEND, 'src/db/migrations-pg');
const FLEET_STATUS = join(BACKEND, 'src/services/fleet-status.ts');
const FLEET_HEALTH = resolve(BACKEND, '../frontend/src/pages/FleetHealth.tsx');

const problems = [];
const fail = (msg) => problems.push(msg);

/** The quoted values inside a `const NAME = [ ... ] as const;` array literal. */
function arrayLiteral(src, name) {
  const re = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/["']([A-Z_]+)["']/g)].map((x) => x[1]);
}

// ── 1. The machine ──────────────────────────────────────────────────────────
const statusSrc = readFileSync(FLEET_STATUS, 'utf8');
const machine = arrayLiteral(statusSrc, 'WORK_ORDER_STATES');
if (!machine || machine.length === 0) {
  fail('Could not read WORK_ORDER_STATES from services/fleet-status.ts.');
}

// ── 2. The database CHECK — LAST writer wins, like the schema itself ────────
// Later migrations DROP and re-ADD the constraint, so the newest file that
// mentions it is the one in force. Sorting by filename is the same order
// pg-migrate applies them in.
let checkStates = null;
let checkFile = null;
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  if (!/lorry_work_orders/.test(sql)) continue;
  const m = /status[^;]*?CHECK\s*\(\s*status\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
  if (!m) continue;
  checkStates = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  checkFile = file;
}
if (!checkStates) fail('Could not find the status CHECK for scm.lorry_work_orders in any migration.');

// ── 3. The stepper ──────────────────────────────────────────────────────────
const healthSrc = readFileSync(FLEET_HEALTH, 'utf8');
const stepper = arrayLiteral(healthSrc, 'WORK_ORDER_STATES');
if (!stepper) fail('Could not read WORK_ORDER_STATES from frontend FleetHealth.tsx.');

// ── Compare ─────────────────────────────────────────────────────────────────
if (machine && stepper) {
  // ORDER matters here, not just membership: the stepper draws the rail in this
  // sequence and positions the current status by index.
  if (machine.join(',') !== stepper.join(',')) {
    fail(
      `The stepper's state list differs from the machine's.\n` +
      `  services/fleet-status.ts : ${machine.join(' -> ')}\n` +
      `  FleetHealth.tsx          : ${stepper.join(' -> ')}`,
    );
  }
  const labels = /WORK_ORDER_STATE_LABEL[^=]*=\s*\{([\s\S]*?)\}/m.exec(healthSrc);
  if (!labels) {
    fail('Could not read WORK_ORDER_STATE_LABEL from FleetHealth.tsx.');
  } else {
    const labelled = new Set([...labels[1].matchAll(/^\s*([A-Z_]+)\s*:/gm)].map((x) => x[1]));
    const unlabelled = machine.filter((s) => !labelled.has(s));
    if (unlabelled.length) fail(`No label in FleetHealth.tsx for: ${unlabelled.join(', ')}`);
  }
}

if (machine && checkStates) {
  const inCheck = new Set(checkStates);
  const missing = machine.filter((s) => !inCheck.has(s));
  // A state the machine can reach but the database refuses is a 500 on that
  // transition, every time.
  if (missing.length) {
    fail(`The status CHECK (${checkFile}) refuses states the machine can reach: ${missing.join(', ')}`);
  }
  const inMachine = new Set(machine);
  const stale = checkStates.filter((s) => !inMachine.has(s));
  // The reverse is not an error on its own — a value the CHECK still allows but
  // the code no longer produces is how you keep old rows readable — so it is
  // reported, not failed.
  if (stale.length) {
    console.log(`note: the CHECK still allows ${stale.join(', ')}, which the machine no longer produces (old rows stay readable).`);
  }
}

if (problems.length) {
  console.error('Work-order state drift:\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`Work-order states are in step — ${machine.length} state(s), CHECK from ${checkFile}, stepper matches.`);
