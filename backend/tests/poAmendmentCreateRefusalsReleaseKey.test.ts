/* The PO amendment modal now keeps ONE idempotency key per attempt (sister
   review G18). A refusal that claimed that key would turn the corrected
   resubmit into 409 idempotency_key_reused, so every refusal the create route
   answers before its first write must release the claim. Runtime proof of the
   release mechanism lives in idempotencyRefusalRelease.test.ts. */
import { describe, it, expect } from 'vitest';
import source from '../src/scm/routes/po-amendments.ts?raw';
import { stripComments } from '../scripts/lib/classify-tests.mjs';

const code: string = stripComments(source);
const start = code.indexOf("poAmendments.post('/', async (c) => {");
const firstWrite = code.indexOf(".from('po_amendments').insert(", start);
const preWrite = code.slice(start, firstWrite);

describe('PO amendment create: refusals before the first write release the key', () => {
  it('finds the handler and its first write', () => {
    expect(start).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(start);
  });

  it('answers every pre-write refusal through refuseWithoutWriting', () => {
    expect(preWrite.match(/refuseWithoutWriting\(/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(preWrite).not.toMatch(/return c\.json\(/);
  });
});
