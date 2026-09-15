/* Adding a line to a sales order: every refusal before the handler's first
   write must release the idempotency claim, so the corrected line can be saved.
 *
 * THE BUG, as the owner hit it (phone, Edit Sales Order, HC-SO-011153,
 * 2026-09-15 12:18 MYT): the phone mints ONE Idempotency-Key per unsaved line
 * and reuses it for every Save. The first Save of a DIVAN ONLY-(SS) line was
 * refused 400 variant_not_allowed (total height 8"). The route answered with a
 * bare c.json, so the middleware STORED that 400 against the key. He picked a
 * Gap, pressed Save again, and got "An earlier submission with different
 * details already finished under this request key ... Saving again will not
 * help" — the claim's hash no longer matched. The only way out was a reload,
 * which throws away the edit. Read from production: idempotency_keys held one
 * row for that key, status 400, body variant_not_allowed.
 *
 * Same dead end docs/bugs records for Goods Receipt (tests/
 * grnPreWriteRefusalsReleaseKey.test.ts), in a handler that never adopted the
 * fix. The release mechanism itself is proven at runtime in
 * idempotencyRefusalRelease.test.ts; this file is the completeness check over
 * the handler's source: no pre-write refusal left on a bare c.json, and nothing
 * at or past the first write releases a claim. */
import { describe, it, expect } from 'vitest';
// ?raw so the assertion reads the real source, in any test runtime.
import { soRouterLineOrigin, soRouterSource } from './lib/so-router-source';
import { stripComments } from '../scripts/lib/classify-tests.mjs';
const routeSource = soRouterSource();

/* A return inside a COMMENT is not an exit, and a write mentioned in one is not a write. */
const lines: string[] = stripComments(routeSource).split('\n');

const HANDLER = "mfgSalesOrders.post('/:docNo/items', async (c) => {";
/* Anything that can leave a row behind. Deliberately generous — a false "this
   wrote" only costs the operator a retype; a missed write would let a corrected
   resubmit add the line twice. The PWP claim is a write: it flips a voucher. */
const WRITES = /\.(insert|update|upsert|rpc)\(|\.delete\(\)|claimPwpForSingleLine\(|rollbackSinglePwpClaim\(|enqueue\w*\(|recordEntityAudit\(/;

const startIdx = lines.findIndex((l) => l.includes(HANDLER));
const nextHandlerIdx = lines.findIndex((l, i) => i > startIdx && /^mfgSalesOrders\.(get|post|patch|put|delete)\(/.test(l));
const endIdx = nextHandlerIdx < 0 ? lines.length : nextHandlerIdx;
const firstWriteIdx = lines.findIndex((l, i) => i > startIdx && i < endIdx && WRITES.test(l));

type Exit = { lineNo: number; text: string };
const exitsBetween = (from: number, to: number): Exit[] =>
  lines
    .map((text, i) => ({ lineNo: i + 1, text: text.trim() }))
    .slice(from, to)
    .filter((e) => /\breturn\b/.test(e.text) && !/\breturn\s+null\s*;/.test(e.text));

const preWrite = exitsBetween(startIdx, firstWriteIdx);
const pastWrite = exitsBetween(firstWriteIdx, endIdx);

describe('POST /:docNo/items — refusals before the first write release the idempotency claim', () => {
  it('finds the handler, and its first write is the PWP claim — the boundary this test is built on', () => {
    expect(startIdx).toBeGreaterThan(0);
    expect(firstWriteIdx).toBeGreaterThan(startIdx);
    expect(lines[firstWriteIdx]).toContain('claimPwpForSingleLine(');
    // A scan over nothing must not read as a pass.
    expect(preWrite.length).toBeGreaterThanOrEqual(18);
  });

  it('leaves no pre-write refusal answering with a bare c.json', () => {
    const missed = preWrite
      .filter((e) => !/return refuseWithoutWriting\(c, /.test(e.text))
      // The lease guard builds its own Response; the next test pins that it releases.
      .filter((e) => e.text !== 'if (leaseBlocked) return leaseBlocked;')
      .map((e) => `${soRouterLineOrigin(e.lineNo)} ${e.text}`);
    expect(missed).toEqual([]);
  });

  it('covers the refusal the owner hit, not only the handful anyone listed', () => {
    const released = preWrite.map((e) => e.text).join('\n');
    expect(released).toContain('return refuseWithoutWriting(c, { ...aoErr, itemCode: itemCodeStr }, 400);');
    for (const exit of ['SO_PROCESSING_LOCKED_RESPONSE', 'SO_PO_LOCKED_RESPONSE', 'badQty', 'SO_FULLY_FROZEN_REFUSAL', 'mainMix.body']) {
      expect(released).toContain(exit);
    }
  });

  it('never releases a claim at or past the first write', () => {
    expect(pastWrite.length).toBeGreaterThan(0);
    expect(pastWrite.filter((e) => e.text.includes('refuseWithoutWriting(')).map((e) => e.text)).toEqual([]);
  });
});

describe('requireSoLineWriteLease — a read-only guard, so every refusal it answers releases', () => {
  const guardStart = lines.findIndex((l) => l.startsWith('async function requireSoLineWriteLease('));
  const guardEnd = lines.findIndex((l, i) => i > guardStart && l.startsWith('}'));
  const guard = lines.slice(guardStart, guardEnd + 1);

  it('reads the lease row and writes nothing', () => {
    expect(guardStart).toBeGreaterThan(0);
    expect(guard.filter((l) => WRITES.test(l))).toEqual([]);
  });

  it('answers every refusal through refuseWithoutWriting', () => {
    const refusals = guard.map((l) => l.trim()).filter((l) => /\breturn\b/.test(l) && !/\breturn\s+null\s*;/.test(l));
    expect(refusals.length).toBe(3);
    expect(refusals.filter((l) => !l.includes('return refuseWithoutWriting(c, '))).toEqual([]);
  });
});
