/* The completeness half of the Purchase Invoice create's dead end.
 *
 * `tests/purchaseInvoiceCreateRefusalDeadEnd.test.ts` proves the release
 * MECHANISM works at runtime — the header surviving c.json() into the Response,
 * the claim row actually being deleted, the corrected payload then succeeding.
 * It cannot prove that no exit was MISSED, and missing one is how this bug
 * survived on grns.ts's sibling for a fortnight: the first fix there landed at
 * the four exits somebody had listed and left the ~80 nobody had. This file is
 * the same check `grnPreWriteRefusalsReleaseKey.test.ts` runs on that router,
 * pointed at this one.
 *
 * SCOPED TO `POST /`, DELIBERATELY, AND THE SCOPE IS A FACT ABOUT THE CLIENT.
 * The claim only exists where a caller sends an `Idempotency-Key`, and exactly
 * one PI call site does: `useCreatePurchaseInvoice`
 * (frontend/src/vendor/scm/lib/purchase-invoice-queries.ts:187-189, through
 * `idempotentInit`). `/from-grn`, `/from-grn-items`, `POST /:id/items` and every
 * PATCH on this router send none — `useCreatePurchaseInvoicesFromGrnItems`
 * (suppliers-queries.ts:922) posts a bare init — so a refusal from them claims
 * nothing and has nothing to release. Widening this gate to them would demand a
 * release for a claim that is never made, which reads as a rule and is
 * cargo cult. If one of them ever starts sending a key, the exemption list
 * below is where that shows up.
 *
 * THE BOUNDARY IS THE HANDLER'S OWN. `insertWithDocNoRetry` is its first
 * mutating call and the code says so; every refusal at or above it is on the
 * safe side by construction. The three past it are named individually, each
 * with the reason a reader can check, because getting one of these wrong is how
 * a corrected resubmit books the supplier's bill twice. */
import { describe, it, expect } from 'vitest';
// ?raw so the assertion reads the real source, in any test runtime.
import routerSource from '../src/scm/routes/purchase-invoices.ts?raw';
import { stripComments } from '../scripts/lib/classify-tests.mjs';

/* A refusal inside a COMMENT is not a refusal, and a write mentioned in one is
   not a write. Same stripper the test-project classifier uses. */
const lines: string[] = stripComments(routerSource).split('\n');
const raw: string[] = routerSource.split('\n');

const start = lines.findIndex((l) => l.startsWith("purchaseInvoices.post('/', async"));
const after = lines.findIndex((l, i) => i > start && /^purchaseInvoices\./.test(l));

it('the create handler is still where this file thinks it is', () => {
  expect(start).toBeGreaterThan(-1);
  expect(after).toBeGreaterThan(start);
});

/* Anything that can leave a row behind, including the helpers that write on the
   handler's behalf. Deliberately generous: a false "this wrote" only costs the
   operator a retype, while a missed write would let a corrected resubmit
   duplicate a payable. */
const WRITES =
  /\.(insert|update|upsert|rpc)\(|\.delete\(\)|insertWithDocNoRetry\(|recordPiCreate\(|recordParentlessCreate\(|enqueue\w*\(|reallocatePiCharges\(|recomputeGrnInvoiced\(|recostForPi\(/;
const RELEASES = /refuseWithoutWriting\(/;

const body = lines.slice(start, after);
const firstWrite = body.findIndex((l) => WRITES.test(l));

type Exit = { lineNo: number; text: string; status: string; releases: boolean };
const exits: Exit[] = [];
body.forEach((text, i) => {
  if (!/return (c\.json|refuseWithoutWriting)\(/.test(text)) return;
  /* The trailing `}` catches the one-line `try { … } catch { return c.json(…, 400); }`
     that opens this handler — an exit is an exit whether or not it ends the line. */
  const status = /, (\d{3})\);?\s*\}?\s*$/.exec(text)?.[1];
  if (!status) return;
  exits.push({
    lineNo: start + i + 1,
    text: raw[start + i]!.trim(),
    status,
    releases: RELEASES.test(text),
  });
});

const isRefusal = (e: Exit) => e.status !== '200' && e.status !== '201';
const beforeFirstWrite = (e: Exit) => firstWrite === -1 || e.lineNo - start - 1 <= firstWrite;

/* An exit that sits LEXICALLY past the first write may still release, but only
   with something a reader can check. There are two admissible proofs.

   The MECHANICAL one, preferred because it cannot go stale: the exit is
   immediately preceded by a `rollbackPi(...)` guard, which deletes the header
   and answers whether the delete actually succeeded — the releasing branch is
   then the one reached only when the undo is PROVEN. Keying that on the exit's
   text would be worthless anyway, since `return refuseWithoutWriting(c, b, 500)`
   says nothing about what happened above it.

   The WRITTEN one, for an exit with no rollback to point at. */
const PROVEN_ROLLBACK = /rollbackPi\(/;
const PAST_A_WRITE: Record<string, string> = {
  'if (hErr) return refuseWithoutWriting(c, insertFailed(hErr.message), 500);':
    'insertWithDocNoRetry returns the LAST attempt\'s error, and an attempt that errored wrote no row; the earlier attempts only minted doc numbers, which are derived from the table.',
};

/** The two non-blank lines above an exit — where its rollback proof would be. */
const precededByRollback = (e: Exit) => {
  const idx = e.lineNo - start - 1;
  return body.slice(Math.max(0, idx - 2), idx).some((l) => PROVEN_ROLLBACK.test(l));
};

describe('every refusal POST /purchase-invoices can emit releases the claim', () => {
  it('finds the handler\'s exits and its first write', () => {
    expect(exits.length).toBeGreaterThan(8);
    expect(firstWrite).toBeGreaterThan(-1);
  });

  it('no refusal before the first write keeps the operator\'s key', () => {
    const stuck = exits
      .filter(isRefusal).filter(beforeFirstWrite).filter((e) => !e.releases)
      .map((e) => `${e.lineNo}: ${e.text}`);
    expect(stuck).toEqual([]);
  });

  it('a refusal past the first write releases only with a written reason', () => {
    const unexplained = exits
      .filter(isRefusal).filter((e) => !beforeFirstWrite(e)).filter((e) => e.releases)
      .filter((e) => !PAST_A_WRITE[e.text] && !precededByRollback(e))
      .map((e) => `${e.lineNo}: ${e.text}`);
    expect(unexplained).toEqual([]);
  });

  /* And the reasons describe exits that still exist — a stale entry here would
     silently stop guarding anything. */
  it('every written reason still names a live exit', () => {
    const live = new Set(exits.map((e) => e.text));
    expect(Object.keys(PAST_A_WRITE).filter((t) => !live.has(t))).toEqual([]);
  });

  /* The success exit is not a refusal and must never release: replaying a
     committed 201 is the whole reason the key exists. */
  it('the 201 does not release', () => {
    const created = exits.filter((e) => e.status === '201');
    expect(created).toHaveLength(1);
    expect(created[0]!.releases).toBe(false);
  });
});
