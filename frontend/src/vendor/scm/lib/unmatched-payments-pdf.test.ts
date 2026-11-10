/* Payments not matched yet on paper (owner 2026-11-10: 也要支持pdf，这个export可以根据我
   显示的column 来export). Pinned: each part reads as its table shows — its title with
   its row count, its money totalled, figures to the right — and, on the real jsPDF,
   one landscape listing with a page per part. Ordinary ASCII: no font fetch. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { jsPDF } from 'jspdf';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import { generateUnmatchedPdf, unmatchedPdfTables, type UnmatchedPdfPart } from './unmatched-payments-pdf';
import { todayMY } from '../../shared/format';

afterEach(() => { deliver.mockClear(); });

const PAYMENTS: UnmatchedPdfPart = {
  title: 'Payments',
  view: {
    keys: ['paidOn', 'document', 'amount', 'days'],
    matrix: {
      header: ['Paid on', 'Document', 'Amount', 'Days'],
      formats: ['date', 'text', 'money', 'number'],
      body: [['2026-10-01', 'SO-1', 1000, 40], ['2026-10-02', 'SO-2', 250.5, 39]],
    },
  },
};
const BANK: UnmatchedPdfPart = {
  title: 'Bank money in',
  view: { keys: ['date', 'amount'], matrix: { header: ['Date', 'Amount'], formats: ['date', 'money'], body: [] } },
};

describe('Payments not matched yet on paper', () => {
  test('each part: its title and rows, its money totalled, figures to the right', () => {
    const [p, b] = unmatchedPdfTables([PAYMENTS, BANK]);
    expect(p!.title).toBe('Payments — 2 rows');
    expect(p!.body[0]).toEqual(['2026/10/01', 'SO-1', '1,000.00', '40']);
    expect(p!.totalSen).toBe(125_050);
    expect(p!.figures).toEqual([false, false, true, true]);
    expect(b!.title).toBe('Bank money in — 0 rows');
    expect(b!.totalSen).toBe(0);
  });

  test('one landscape listing, a page per part', async () => {
    await generateUnmatchedPdf([PAYMENTS, BANK], { subtitle: 'Dated 2026/09/01 to 2026/11/10', action: 'print' });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [doc, name, action] = deliver.mock.calls[0]! as [jsPDF, string, string];
    expect(name).toBe(`payments-not-matched-${todayMY()}.pdf`);
    expect(action).toBe('print');
    expect(doc.internal.pageSize.getWidth()).toBeGreaterThan(doc.internal.pageSize.getHeight());
    expect(doc.getNumberOfPages()).toBe(2);
  });
});
