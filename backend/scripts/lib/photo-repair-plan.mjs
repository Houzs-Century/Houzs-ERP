// ---------------------------------------------------------------------------
// photo-repair-plan.mjs — the plan file that lets a photo repair be COMPUTED
// where the bucket can be asked and APPLIED where the database can be written,
// as PURE functions: values in, verdict out. No filesystem, no database, no
// network, no process.exit. The scripts do the I/O and own the verdict.
//
// WHY A PLAN FILE AT ALL. Both AutoCount line-photo repairs need two
// credentials in ONE process:
//   · R2_API_TOKEN — "this address is dead" / "this photograph exists" is a
//     fact about the bucket and about nothing else;
//   · a WRITING DATABASE_URL.
// This repository is PUBLIC, so the R2 token can never be an Actions secret —
// it reads every photograph the company owns — and the operator machine's DSN
// connects read-only. Neither place can run the repair. So the plan is written
// on the machine that can ask R2, and applied by a workflow that holds only
// `secrets.DATABASE_URL`.
//
// WHY THE FRESHNESS GUARD IS THE WHOLE DESIGN. A plan file is a KEY LOG, and
// this repo has already paid for replaying one:
// backfill-photo-urls-from-keys.mjs replayed the round-1 (2026-08-10) attach
// log on 2026-08-28 and attached 64 addresses whose object was never uploaded
// (docs/bugs/0625-a-backfill-replayed-the-round-1-photo-key-log-without-asking.md).
// The log was not wrong when it was written; it was wrong eighteen days later.
//
// A minutes-old plan is a different object from a month-old log ONLY IF
// something enforces the difference, so the difference is enforced here and
// pinned by backend/tests/photoRepairPlanHandoff.test.ts:
//
//   1. AGE          older than PLAN_MAX_AGE_CEILING_MIN and it is refused. The
//                   ceiling may be lowered, never raised.
//   2. DIGEST       the file's digest covers the HEADER as well as the
//                   operations, so re-dating a stale plan to smuggle it past
//                   rule 1 breaks rule 2.
//   3. IDENTITY     a plan for another company, bucket, account or repair is
//                   refused rather than half-applied.
//   4. PER ROW      the row must still carry what the plan expected to find,
//                   and must not already carry what the plan was going to add.
//                   This is the one that catches a plan that WAS true and is
//                   not any more, row by row.
//
// What rule 4 does NOT cover, said plainly: for the RE-POINT repair the plan
// also asserts that no OTHER row of the same AutoCount line already shows that
// picture, which cannot be re-judged without R2. That half is certified by the
// plan and bounded by rule 1 — it is the reason the ceiling is two hours and
// not two days.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/** The oldest a plan may be when it is applied. Minutes. */
export const PLAN_MAX_AGE_CEILING_MIN = 120;

/** How far ahead of us a plan may be dated before we call it a forged clock. */
export const PLAN_FUTURE_SKEW_MIN = 5;

export const PRUNE_KIND = 'prune-dead-line-photo-keys';
export const REPOINT_KIND = 'repoint-line-photos-to-owning-line';

/**
 * The row precondition each repair depends on, derived from the operation
 * itself so there is ONE source of truth rather than a copy in the file that
 * could disagree with the fields beside it.
 *
 *   expect  every address must STILL be on the row.
 *   forbid  no address may be on the row YET.
 */
export const PLAN_KINDS = {
  [PRUNE_KIND]: {
    /* The dead address must still be there (otherwise somebody already pruned
       it and this plan is spent) and so must every live sibling that LICENSED
       the drop — without them, dropping would leave the line with no picture at
       all, which is the one thing this repair promises never to do. */
    precondition: (op) => ({ expect: [op.drop, ...(op.keeps ?? [])], forbid: [] }),
    describe: (op) => `${op.doc} AC line ${op.dtl} drop ${op.drop}`,
  },
  [REPOINT_KIND]: {
    /* The column must be exactly as the plan saw it: everything it saw is still
       there, and nothing it was going to add is there already. A row that
       gained the address in the meantime means the repair already happened. */
    precondition: (op) => ({ expect: [...(op.before ?? [])], forbid: [...(op.add ?? [])] }),
    describe: (op) => `${op.doc} AC line ${op.dtl} add ${(op.add ?? []).join(' , ')}`,
  },
};

/**
 * JSON with object keys in a stable order, so the same plan always digests to
 * the same string. Arrays keep their order — an operation list is a sequence.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * The digest of a plan — over EVERYTHING except the digest field itself.
 *
 * Covering the header and not only `ops` is deliberate and is what makes the
 * age check unforgeable: editing `generatedAt` to make a stale plan look fresh
 * changes the digest, so rule 1 cannot be smuggled past by editing the file.
 */
export function planDigest(plan) {
  const { digest: _ignored, ...body } = plan ?? {};
  return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

/**
 * Build the plan file's contents. `generatedAt` is injected so a test can pin
 * the clock; the scripts pass `new Date()`.
 */
export function buildPlan({ kind, account, bucket, company, ops, generatedAt = new Date() }) {
  const body = {
    kind,
    generatedAt: new Date(generatedAt).toISOString(),
    account,
    bucket,
    company: Number(company),
    count: ops.length,
    ops,
  };
  return { ...body, digest: planDigest(body) };
}

/**
 * The apply-side age ceiling. It may be LOWERED by the caller and never raised,
 * because the ceiling is the only thing standing between this design and the
 * month-old key log it exists to not repeat.
 *
 * @returns {{minutes: number}|{error: string}}
 */
export function resolveMaxAgeMinutes(raw, ceiling = PLAN_MAX_AGE_CEILING_MIN) {
  if (raw === undefined || raw === null || raw === '') return { minutes: ceiling };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `PLAN_MAX_AGE_MINUTES="${raw}" is not a number.` };
  if (n <= 0) return { error: `PLAN_MAX_AGE_MINUTES=${n} must be positive.` };
  if (n > ceiling) {
    return { error: `PLAN_MAX_AGE_MINUTES=${n} asks for longer than the ${ceiling}-minute ceiling. The ceiling may be lowered, never raised.` };
  }
  return { minutes: n };
}

const problem = (code, why) => ({ code, why });

/**
 * Everything about the plan that can be judged before a single row is read.
 *
 * @param plan     the parsed file
 * @param expect   { kind, account, bucket, company, now, maxAgeMinutes, arms? }
 * @returns {{ok: boolean, problems: {code,why}[], ageMinutes: number|null}}
 */
export function verifyPlanEnvelope(plan, expect) {
  const problems = [];
  const {
    kind, account, bucket, company, now = new Date(),
    maxAgeMinutes = PLAN_MAX_AGE_CEILING_MIN,
    futureSkewMinutes = PLAN_FUTURE_SKEW_MIN,
    arms = null,
  } = expect ?? {};

  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.ops)) {
    return { ok: false, problems: [problem('plan-shape', 'the file is not a plan object with an `ops` array')], ageMinutes: null };
  }

  if (plan.kind !== kind) problems.push(problem('wrong-kind', `the plan is for "${plan.kind}", this script is "${kind}"`));
  if (plan.account !== account) problems.push(problem('wrong-account', `the plan was computed against R2 account ${plan.account}, this run points at ${account}`));
  if (plan.bucket !== bucket) problems.push(problem('wrong-bucket', `the plan was computed against bucket ${plan.bucket}, this run points at ${bucket}`));
  if (Number(plan.company) !== Number(company)) problems.push(problem('wrong-company', `the plan is for company ${plan.company}, this run is company ${company}`));

  /* The digest is checked over the file as it stands, count included, so a
     doctored count fails HERE rather than needing a rule of its own. */
  const recomputed = planDigest(plan);
  if (typeof plan.digest !== 'string' || plan.digest !== recomputed) {
    problems.push(problem('digest-mismatch', `the plan does not match its own digest — it was edited after it was written (file says ${plan.digest ?? '(none)'}, contents say ${recomputed})`));
  }

  let ageMinutes = null;
  const written = Date.parse(plan.generatedAt ?? '');
  if (!Number.isFinite(written)) {
    problems.push(problem('bad-timestamp', `generatedAt="${plan.generatedAt}" is not a date`));
  } else {
    ageMinutes = (new Date(now).getTime() - written) / 60_000;
    if (ageMinutes < -futureSkewMinutes) {
      problems.push(problem('future', `the plan is dated ${Math.round(-ageMinutes)} minute(s) in the future — refusing rather than trusting a clock`));
    } else if (ageMinutes > maxAgeMinutes) {
      problems.push(problem('stale', `the plan is ${Math.round(ageMinutes)} minute(s) old and the ceiling is ${maxAgeMinutes}. Re-run the PLAN and apply the new file — a key log stops being true.`));
    }
  }

  /* An op names its arm, never its TABLE. The apply path resolves the table
     from its own constant, so a plan can never nominate what gets written to. */
  if (arms) {
    const known = new Set(arms);
    const strangers = [...new Set(plan.ops.map((o) => o?.arm).filter((a) => !known.has(a)))];
    if (strangers.length) problems.push(problem('unknown-arm', `the plan names arm(s) this script does not have: ${strangers.join(', ')}`));
  }

  return { ok: problems.length === 0, problems, ageMinutes };
}

/**
 * The per-row guard. This is what stops a plan that was TRUE when it was
 * written and is not any more — checked against the row as it is RIGHT NOW,
 * inside the apply run, one row at a time.
 *
 * @param kind         PRUNE_KIND | REPOINT_KIND
 * @param op           one operation from the plan
 * @param currentPics  the row's photo_urls as just read from the database
 */
export function checkRowPrecondition(kind, op, currentPics) {
  const spec = PLAN_KINDS[kind];
  if (!spec) return { ok: false, code: 'unknown-kind', why: `no precondition is defined for "${kind}"` };
  if (!Array.isArray(currentPics)) {
    return {
      ok: false,
      code: 'not-an-array',
      why: `the row is gone, or photo_urls is ${currentPics === null || currentPics === undefined ? 'absent' : typeof currentPics}, not an array`,
    };
  }
  const { expect, forbid } = spec.precondition(op);
  const have = new Set(currentPics);

  const missing = expect.filter((k) => !have.has(k));
  if (missing.length) {
    return {
      ok: false,
      code: 'drifted-missing',
      why: `the column moved after the plan was written — it no longer lists ${missing.length} address(es) the plan relied on: ${missing.join(' , ')}`,
    };
  }
  const already = forbid.filter((k) => have.has(k));
  if (already.length) {
    return {
      ok: false,
      code: 'drifted-present',
      why: `the column moved after the plan was written — it already lists ${already.length} address(es) the plan was going to add: ${already.join(' , ')}`,
    };
  }
  return { ok: true };
}
