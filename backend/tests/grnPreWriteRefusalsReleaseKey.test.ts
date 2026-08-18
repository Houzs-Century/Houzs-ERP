/* Every refusal `grns.ts` emits BEFORE its first write must release the
   idempotency claim — not just the zero-cost one that was reported.
 *
 * THE BUG, as staff hit it (Goods Receipt from a PO, 2026-08-17): the form
 * sends one Idempotency-Key per mount, so a refused submit CLAIMED that key
 * against its own payload hash. The operator did what the refusal told them,
 * corrected the payload, pressed Save — and got 409 idempotency_key_reused,
 * because the corrected payload no longer matched the claim. The only way out
 * was a page reload, which threw away the whole receipt.
 *
 * That is not a property of the zero-cost guard. It is a property of EVERY
 * refusal an operator is expected to correct and retry, and this file exists
 * because the first fix landed at the four exits somebody had listed and left
 * the ~80 nobody had. `warehouse_required`, `qty_exceeds_remaining`,
 * `po_not_receivable`, `grn_locked` and the child/consumed locks are all the
 * same dead end.
 *
 * THE BOUNDARY IS THE FILE'S OWN. grns.ts documents its nine audit pre-flights
 * as sitting "after every auth / validation / read guard ... and strictly
 * before the handler's FIRST mutating call". So "before the first write" is
 * not a judgement this test invents; it is where the file already draws the
 * line, and it is mechanically checkable.
 *
 * WHAT THIS FILE IS AND IS NOT. It is a COMPLETENESS check over source shape:
 * that no pre-write refusal was missed, and that nothing past a write releases
 * a claim without a written reason. That the release MECHANISM works — the
 * header surviving c.json() into the Response, the row actually being deleted,
 * the corrected payload then succeeding — is proven at runtime, through real
 * Hono and the real middleware, in idempotencyRefusalRelease.test.ts. Neither
 * substitutes for the other. */
import { describe, it, expect } from 'vitest';
// ?raw so the assertion reads the real source, in any test runtime.
import grnsSource from '../src/scm/routes/grns.ts?raw';
import guardSource from '../src/scm/lib/zero-cost-receipt-guard.ts?raw';
import { stripComments } from '../scripts/lib/classify-tests.mjs';

/* A refusal inside a COMMENT is not a refusal, and a write mentioned in one is
   not a write. Same stripper the test-project classifier uses, for the same
   reason it exists there. */
const lines: string[] = stripComments(grnsSource).split('\n');
const raw: string[] = grnsSource.split('\n');

const HANDLER_START = /^grns\.(post|patch|put|delete)\(|^export const \w+Handler = async/;
/* Anything that can leave a row behind, including the helpers that write on the
   route's behalf. Deliberately generous: a false "this wrote" only costs the
   operator a retype, while a missed write would let a corrected resubmit
   duplicate a document. */
const WRITES =
  /\.(insert|update|upsert|rpc)\(|\.delete\(\)|env\.DB\.prepare|recordEntityAudit\(|recordGrnCreate\(|enqueue\w*\(|insertWithDocNoRetry\(|postGrnAndRollup\(|writeMovements\(/;
const RELEASES = /refuseWithoutWriting\(|refuseZeroCostReceipt\(/;

type Exit = { lineNo: number; text: string; status: string; releases: boolean };
type Handler = { startLine: number; firstWrite: number | null; exits: Exit[] };

const handlers: Handler[] = [];
const startLines = lines
  .map((text, i) => ({ text, lineNo: i + 1 }))
  .filter(({ text }) => HANDLER_START.test(text))
  .map(({ lineNo }) => lineNo);

startLines.forEach((startLine, index) => {
  const end = (startLines[index + 1] ?? lines.length + 1) - 1;
  let firstWrite: number | null = null;
  for (let n = startLine; n <= end; n += 1) {
    if (WRITES.test(lines[n - 1]!)) { firstWrite = n; break; }
  }
  const exits: Exit[] = [];
  for (let n = startLine; n <= end; n += 1) {
    const text = lines[n - 1]!;
    const status = /return (?:c\.json|refuseWithoutWriting)\(.*, (\d{3})\)/.exec(text)?.[1]
      ?? (RELEASES.test(text) ? '409' : null);
    if (!status || !/return (c\.json|refuseWithoutWriting|refuseZeroCostReceipt)\(/.test(text)) continue;
    exits.push({ lineNo: n, text: raw[n - 1]!.trim(), status, releases: RELEASES.test(text) });
  }
  handlers.push({ startLine, firstWrite, exits });
});

const beforeFirstWrite = (h: Handler, e: Exit) => h.firstWrite === null || e.lineNo <= h.firstWrite;
const isRefusal = (e: Exit) => e.status !== '200' && e.status !== '201';

/* An exit that sits LEXICALLY after a write but is still reachable only when
   nothing survives. Each needs a reason a reader can check, because getting one
   of these wrong is how a corrected resubmit receives the same goods twice. */
const RELEASES_PAST_A_WRITE: Record<string, string> = {
  'return refuseZeroCostReceipt(c, postRes.zeroCost, { nothingWritten: true });':
    'POST / and POST /from-pos: both delete their grn_items and grns rows in the two lines above, and the zero-cost gate returns before postGrnAndRollup flips status or moves stock.',
  'if (res.zeroCost) return refuseZeroCostReceipt(c, res.zeroCost, { nothingWritten: true });':
    'PATCH /:id/post: the zero-cost gate inside postGrnAndRollup returns before the CAS status flip, so the GRN is still DRAFT and nothing moved.',
  'return refuseZeroCostReceipt(c, { ...zeroCostRefusal, created }, { nothingWritten: created.length === 0 });':
    'POST /from-po-items: one GRN per supplier bucket, so this one is CONDITIONAL — an earlier bucket can have committed its document, its stock IN and its AutoCount conversion, and `created` is empty exactly when every bucket rolled back.',
  'if (childLock) return refuseWithoutWriting(c, childLock, 409);':
    'PATCH /:id/cancel: only the DRAFT short-circuit above writes, and it RETURNS. Reaching this line means the GRN was not DRAFT and the status flip is still below.',
  'if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);':
    'PATCH /:id/cancel: same reason as the child lock directly above it.',
};

describe('grns.ts refusals that precede any write release the idempotency claim', () => {
  it('finds real handlers and real writes — a scan over nothing must not read as a pass', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(9);
    const withExits = handlers.filter((h) => h.exits.length > 0);
    expect(withExits.length).toBeGreaterThanOrEqual(9);
    // Every handler that refuses also writes somewhere, or the boundary this
    // test is built on does not exist in it.
    expect(withExits.filter((h) => h.firstWrite === null)).toEqual([]);
  });

  it('leaves no pre-write refusal answering with a bare c.json', () => {
    const missed = handlers.flatMap((h) =>
      h.exits
        .filter((e) => isRefusal(e) && beforeFirstWrite(h, e) && !e.releases)
        .map((e) => `grns.ts:${e.lineNo} [${e.status}] ${e.text}`),
    );
    expect(missed).toEqual([]);
  });

  it('covers the whole class, not the handful that were reported', () => {
    const released = handlers.flatMap((h) => h.exits.filter((e) => e.releases));
    /* The reported zero-cost exits are four of these. A fix that stopped there
       would leave the same dead end on warehouse_required, qty_exceeds_remaining,
       po_not_receivable, grn_locked and the child/consumed locks. */
    const codes = new Set(
      released.map((e) => /'([a-z_]+)'/.exec(e.text)?.[1]).filter(Boolean) as string[],
    );
    for (const code of ['qty_exceeds_remaining', 'po_not_receivable', 'grn_locked', 'warehouse_required']) {
      expect([...codes]).toContain(code);
    }
    // The four reported ones (they carry the body in a variable, not a literal).
    expect(released.filter((e) => e.text.includes('refuseZeroCostReceipt('))).toHaveLength(4);
    expect(released.length).toBeGreaterThan(4);
  });

  it('releases past a write only where a written reason says why that is safe', () => {
    const past = handlers.flatMap((h) =>
      h.exits.filter((e) => e.releases && !beforeFirstWrite(h, e)).map((e) => e.text),
    );
    for (const text of past) {
      expect(RELEASES_PAST_A_WRITE[text], `grns.ts has no recorded reason for: ${text}`).toBeTruthy();
    }
    // And the ledger may not outlive the code it explains.
    for (const text of Object.keys(RELEASES_PAST_A_WRITE)) {
      expect(past, `the ledger still explains an exit grns.ts no longer has: ${text}`).toContain(text);
    }
  });

  it('keeps the zero-cost proof a REQUIRED argument, so a new exit cannot forget it', () => {
    // `proof?:` or a default would let a forgotten call site silently keep the
    // permissive answer — the optional-param-noop class in BUG-HISTORY.
    expect(guardSource).toMatch(/proof: \{ nothingWritten: boolean \}/);
    expect(guardSource).not.toMatch(/proof\?:/);
  });
});
