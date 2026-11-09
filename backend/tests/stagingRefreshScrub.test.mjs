import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

// The prod -> staging copy must never carry a usable production credential
// (sessions, password hashes, TOTP, POS PINs) or a real HR identifier. The
// scrub is SQL inside the workflow, so this pins the parts that make it safe:
// it always runs, runs before the staging account is re-seeded, and a
// shape-based check after the seed fails the run if anything survived.

const WF = readFileSync(
  path.resolve(__dirname, "../../.github/workflows/staging-refresh-data.yml"),
  "utf8",
);

function step(name) {
  const start = WF.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" is missing`);
  const next = WF.indexOf("\n      - ", start + 1);
  return { start, body: WF.slice(start, next < 0 ? undefined : next) };
}

const SCRUB = "Scrub credentials, sessions and payroll identifiers";
const SEED = "Re-seed the staging login + showroom";
const VERIFY = "Verify no production credential survived (fails the run)";

const TOKEN_TABLES = [
  "public.sessions",
  "public.password_resets",
  "public.invitations",
  "public.push_devices",
  "public.share_export_log",
  "public.contractor_share_tokens",
  "public.brand_share_tokens",
  "public.email_outbox",
];

test("the scrub runs after the restore, before the seed, and the check runs after the seed", () => {
  const restore = step("Restore data").start;
  const scrub = step(SCRUB).start;
  const seed = step(SEED).start;
  const verify = step(VERIFY).start;
  assert.ok(restore < scrub && scrub < seed && seed < verify, "order must be restore -> scrub -> seed -> verify");
});

test("neither the scrub nor the check can be switched off by an input", () => {
  for (const name of [SCRUB, VERIFY]) {
    assert.doesNotMatch(step(name).body, /^\s+if:/m, `"${name}" must not carry an if:`);
    assert.doesNotMatch(step(name).body, /continue-on-error/, `"${name}" must fail the run`);
  }
});

test("every token table is emptied and every one is checked afterwards", () => {
  const scrub = step(SCRUB).body;
  const verify = step(VERIFY).body;
  for (const t of TOKEN_TABLES) {
    assert.ok(scrub.includes(`'${t}'`), `scrub does not delete ${t}`);
    assert.ok(verify.includes(`'${t}'`), `check does not look at ${t}`);
  }
  // DELETE, never TRUNCATE ... CASCADE: a cascade could silently empty a
  // document table that references one of these.
  assert.match(scrub, /execute format\('delete from %s', t\)/);
  assert.doesNotMatch(scrub, /truncate/i);
});

test("password hashes are replaced by a value verifyPassword can never accept", () => {
  const scrub = step(SCRUB).body;
  const m = /update public\.users set password_hash = '([^']*)'/.exec(scrub);
  assert.ok(m, "users.password_hash is not reset");
  // services/auth.ts verifyPassword returns false for a stored value with no '$'.
  assert.ok(!m[1].includes("$"), "the replacement hash must contain no '$'");
  assert.match(scrub, /totp_secret = null/);
  assert.match(scrub, /totp_backup_codes = null/);
  assert.match(scrub, /pos_cashiers set pin_hash = 'staging-scrubbed'/);
  assert.match(scrub, /scm\.pos_pins set pin_hash = 'staging-scrubbed'/);
});

test("HR identifiers are masked and salaries never pass through unchanged", () => {
  const scrub = step(SCRUB).body;
  for (const col of ["ic_number", "passport_number", "bank_account"]) {
    assert.match(scrub, new RegExp(`${col}\\s+= case`), `hr_employees.${col} is not masked`);
  }
  assert.match(scrub, /sales_reps set nric = 'STG-'/);
  assert.match(scrub, /scm\.helpers set ic_number = 'STG-'/);
  // The factor is drawn from 0.60-0.99 and 1.01-1.40: never exactly 1.
  assert.match(scrub, /case when m < 40 then 0\.60 \+ m \/ 100\.0 else 1\.01 \+ \(m - 40\) \/ 100\.0 end/);
  assert.match(scrub, /% 80 as m/);
});

test("the check is on shape, not on counts alone, and raises when anything survived", () => {
  const verify = step(VERIFY).body;
  assert.match(verify, /SCRUB_STARTED: \$\{\{ steps\.scrub\.outputs\.started \}\}/);
  assert.match(verify, /password_hash like '%\$%' and lower\(email\) <> 'hello@houzscentury\.com'/);
  assert.match(verify, /replace\(created_at::text, ''T'', '' ''\) < %L/);
  assert.match(verify, /not like 'STG-%'/);
  assert.match(verify, /raise exception 'PRODUCTION DATA SURVIVED THE SCRUB/);
});
