/* A long value in the right-hand info column of a printed document (a project
   name, a customer reference, a PI's PO list) was drawn on one line from 33 mm
   right of centre and ran past the page margin. Measured on the text as drawn.
   Sister finding: Conts #743. */
import { describe, expect, test } from 'vitest';
import { jsPDF } from 'jspdf';
import { drawInfoColumns } from './pdf-common';

const PAGE_W = 210;
const MARGIN = 14;
const LONG = 'TESTING MS PEACOCK MEDIUM RM37955 WITH A VERY LONG UNIT NAME AND MORE WORDS';

function drawnTexts(draw: (doc: jsPDF) => number) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const drawn: Array<{ text: string; x: number }> = [];
  const original = doc.text.bind(doc);
  doc.text = ((...args: Parameters<typeof doc.text>) => {
    const [v, x] = args;
    for (const t of Array.isArray(v) ? v : [v]) drawn.push({ text: String(t), x });
    return original(...args);
  }) as typeof doc.text;
  const endY = draw(doc);
  return { doc, drawn, endY };
}

describe('drawInfoColumns keeps the right column inside the page margin', () => {
  test('a long single value wraps onto more lines', () => {
    const { doc, drawn } = drawnTexts((d) => drawInfoColumns(d, 60, { title: 'BILL TO', rows: [] }, {
      title: 'DETAILS', rows: [['Project', LONG]],
    }));
    const lines = drawn.filter((t) => /TESTING|UNIT|MORE|WORDS/.test(t.text));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.x + doc.getTextWidth(l.text)).toBeLessThanOrEqual(PAGE_W - MARGIN + 0.5);
  });

  test('a long element of a list value wraps too', () => {
    const { doc, drawn } = drawnTexts((d) => drawInfoColumns(d, 60, { title: 'SUPPLIER', rows: [] }, {
      title: 'DETAILS', rows: [['PO No', ['PO-0001', LONG]]],
    }));
    const lines = drawn.filter((t) => /TESTING|UNIT|MORE|WORDS/.test(t.text));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.x + doc.getTextWidth(l.text)).toBeLessThanOrEqual(PAGE_W - MARGIN + 0.5);
  });

  test('the block grows by the wrapped lines, and a short value is unchanged', () => {
    const short = drawnTexts((d) => drawInfoColumns(d, 60, { title: 'A', rows: [] }, { title: 'B', rows: [['SO No', 'HC-SO-2611-001']] }));
    const long = drawnTexts((d) => drawInfoColumns(d, 60, { title: 'A', rows: [] }, { title: 'B', rows: [['SO No', LONG]] }));
    expect(short.drawn.some((t) => t.text === ': HC-SO-2611-001')).toBe(true);
    expect(long.endY).toBeGreaterThan(short.endY);
  });
});
