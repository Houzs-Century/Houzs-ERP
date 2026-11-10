// pdf-raw-text must inflate a stream whose compressed bytes end in 0x0D — the
// merge-queue flake on purchase-order-pdf-cancelled.test.ts (2 of 3 stamps).
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pdfRawText } from './pdf-raw-text';

describe('pdfRawText', () => {
  it('inflates a stream whose last compressed byte is a carriage return', () => {
    let text = '';
    let packed = Buffer.alloc(0);
    for (let i = 0; i < 5_000; i += 1) {
      text = `(CANCELLED) Tj ${"x".repeat(i)}`;
      packed = deflateSync(Buffer.from(text, 'latin1'));
      if (packed[packed.length - 1] === 0x0d) break;
    }
    expect(packed[packed.length - 1]).toBe(0x0d);
    const pdf = Buffer.concat([Buffer.from('1 0 obj\n<< /Length 9 /Filter /FlateDecode >>\nstream\n', 'latin1'), packed, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    expect(pdfRawText(new Uint8Array(pdf))).toContain(text);
  });
});
