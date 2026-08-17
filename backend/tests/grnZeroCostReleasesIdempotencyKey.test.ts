/* The zero-cost receipt guard is a REFUSAL the operator is told to correct and
   retry — "enter the unit price from the supplier goods-received document".
   Staff could not: with an Idempotency-Key on the request, the corrected
   payload no longer matched the claimed request hash, so submit 2 came back
   409 idempotency_key_reused and the only way out was a page reload that threw
   away everything typed. A guard whose whole point is "fix this and try again"
   had made trying again impossible.

   The middleware releases a claim on exactly ONE signal — the route calling
   markIdempotencyNoWrite(c) — and it deliberately refuses to infer that from a
   4xx status, because legacy routes can 4xx after a partial write. So what has
   to be pinned is that every zero-cost exit STATES what it left behind, and
   that the one exit which can leave a committed document behind does not claim
   otherwise. Both halves are load-bearing in opposite directions: forget the
   marker and the operator is locked out again; give it unconditionally on the
   batch route and a corrected resubmit receives already-received goods twice.

   Source-shape on purpose: these exits sit inside multi hundred-line handlers
   whose only other reachable ends are commits, and the property is one the next
   author has to repeat rather than inherit. */
import { describe, it, expect } from 'vitest';
// ?raw so the assertion reads the real source, in any test runtime.
import grnsSource from '../src/scm/routes/grns.ts?raw';
import guardSource from '../src/scm/lib/zero-cost-receipt-guard.ts?raw';
import { refuseZeroCostReceipt } from '../src/scm/lib/zero-cost-receipt-guard';

const callSites = grnsSource
  .split('\n')
  .map((text, i) => ({ lineNo: i + 1, text: text.trim() }))
  .filter(({ text }) => text.includes('refuseZeroCostReceipt(c,'));

describe('GRN zero-cost refusals release the idempotency key', () => {
  it('every zero-cost exit goes through the helper — none answers with a bare c.json', () => {
    const bare = grnsSource
      .split('\n')
      .map((text, i) => ({ lineNo: i + 1, text: text.trim() }))
      .filter(({ text }) => /c\.json\(.*zeroCost/i.test(text))
      .map(({ lineNo, text }) => `grns.ts:${lineNo} ${text}`);
    expect(bare).toEqual([]);
    // Four today: POST /, POST /from-pos, PATCH /:id/post, POST /from-po-items.
    // The count is here so a NEW exit cannot be added without reading this.
    expect(callSites).toHaveLength(4);
  });

  it("the helper marks the request as no-write only on the caller's own proof", () => {
    const marked: string[] = [];
    const c = {
      header: (name: string, value: string) => marked.push(`${name}: ${value}`),
      json: (body: unknown, status: number) => ({ body, status }),
    } as unknown as Parameters<typeof refuseZeroCostReceipt>[0];

    const refused = refuseZeroCostReceipt(c, { error: 'zero_cost_receipt' }, {
      nothingWritten: true,
    }) as unknown as { status: number };
    expect(refused.status).toBe(409);
    expect(marked).toEqual(['Idempotency-Outcome: no-write']);

    marked.length = 0;
    const kept = refuseZeroCostReceipt(c, { error: 'zero_cost_receipt' }, {
      nothingWritten: false,
    }) as unknown as { status: number };
    expect(kept.status).toBe(409);
    expect(marked).toEqual([]);
  });

  it('the proof is a REQUIRED argument, so a new exit cannot forget to state it', () => {
    // `proof?:` or a default would let a forgotten call site silently keep the
    // permissive answer — the optional-param-noop class in BUG-HISTORY.
    expect(guardSource).toMatch(/proof: \{ nothingWritten: boolean \}/);
    expect(guardSource).not.toMatch(/proof\?:/);
  });

  it('the three single-document routes state it unconditionally — they roll fully back', () => {
    const singles = callSites.filter(({ text }) => !text.includes('created'));
    expect(singles).toHaveLength(3);
    for (const { lineNo, text } of singles) {
      expect(`grns.ts:${lineNo} ${text}`).toContain('nothingWritten: true');
    }
  });

  it('the BATCH route states it only when nothing survived — a committed bucket keeps the claim', () => {
    /* POST /from-po-items raises one GRN per supplier bucket. An earlier bucket
       can have committed its document, its stock IN and its AutoCount
       conversion before a later one is refused; releasing the key then would
       let a corrected resubmit receive those goods a SECOND time. `created` is
       empty exactly when every bucket was rolled back, which is why it — and
       never the 409 — is the condition. */
    const batch = callSites.filter(({ text }) => text.includes('created'));
    expect(batch).toHaveLength(1);
    expect(batch[0]!.text).toContain('nothingWritten: created.length === 0');
  });
});
