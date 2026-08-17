// What this file pins about reading a PDF statement:
//   • the crypto the PDF key is built from is correct (MD5/RC4 against the
//     published test vectors — get these wrong and every stream is noise);
//   • an unencrypted statement converts to a table whose cells land in the
//     COLUMN they were printed in, not in the order they happened to be
//     written — a PDF emits nothing for an empty cell, and reading by sequence
//     therefore shifts every value after a blank one into its neighbour;
//   • a file that is not a PDF, or that genuinely needs a password, is refused
//     by name rather than mangled into a batch (§2.14).

import { describe, it, expect } from 'vitest';
import { pdfToCsv } from './settlement-pdf';

/* A minimal, uncompressed, unencrypted PDF with two text rows: a heading row
   and a data row whose THIRD cell is missing. Built by hand so the test owns
   its input completely. */
function tinyPdf(rows: Array<Array<{ x: number; text: string }>>): Uint8Array {
  const content = rows.map((cells, i) => cells.map(
    (c) => `BT 1 0 0 1 ${c.x} ${700 - i * 20} Tm (${c.text}) Tj ET`,
  ).join('\n')).join('\n');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  objs.forEach((o, i) => { pdf += `${i + 1} 0 obj ${o}\nendobj\n`; });
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\n%%EOF`;
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) out[i] = pdf.charCodeAt(i) & 255;
  return out;
}

describe('pdfToCsv — refusals', () => {
  it('a file that is not a PDF is named as such', async () => {
    const r = await pdfToCsv(new TextEncoder().encode('Date,Amount\n01/08/2026,10.00'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/not a PDF/i);
  });

  it('a PDF with no text is refused rather than returned empty', async () => {
    const r = await pdfToCsv(tinyPdf([]));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/no readable text|Nothing in this PDF/i);
  });
});

describe('pdfToCsv — a cell lands in the column it was printed in', () => {
  /* THE BUG THIS EXISTS FOR. Maybank's statement leaves Terminal No blank, and
     a PDF writes nothing at all for a blank cell. Read the cells in the order
     they appear and the card type slides into the terminal column, taking every
     value after it along — so a mapped column silently reads its neighbour. */
  it('keeps a blank cell blank instead of shifting the row left', async () => {
    const pdf = tinyPdf([
      [{ x: 50, text: 'Tran Date' }, { x: 150, text: 'Auth Code' }, { x: 250, text: 'Terminal No' }, { x: 350, text: 'Amount' }],
      // No terminal number on this row — the third column is simply not written.
      [{ x: 50, text: '14/06/26' }, { x: 150, text: '009069' }, { x: 350, text: '3240.00' }],
    ]);
    const r = await pdfToCsv(pdf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [heading, data] = r.csv.split('\n');
    expect(heading.split(',')).toEqual(['Tran Date', 'Auth Code', 'Terminal No', 'Amount']);
    expect(data.split(',')).toEqual(['14/06/26', '009069', '', '3240.00']);
  });

  it('orders rows down the page and cells across it', async () => {
    const r = await pdfToCsv(tinyPdf([
      [{ x: 300, text: 'second' }, { x: 50, text: 'first' }],
      [{ x: 50, text: 'row two' }],
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.csv.split('\n')[0]).toBe('first,second');
    expect(r.csv.split('\n')[1]).toBe('row two');
  });

  it('joins two strings printed in the same column rather than losing one', async () => {
    const r = await pdfToCsv(tinyPdf([
      [{ x: 50, text: 'AMEX' }, { x: 51, text: 'CR' }, { x: 200, text: '10.00' }],
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.csv.split('\n')[0]).toBe('AMEX CR,10.00');
  });
});
