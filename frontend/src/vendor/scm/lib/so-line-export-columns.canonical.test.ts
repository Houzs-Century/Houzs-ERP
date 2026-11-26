import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  SO_DEFAULT_COLUMNS,
  SO_LABELS,
  SO_STATUS_WORDS,
  senToRinggit,
  soListStatusWord,
  type SoDeliveryState,
  type SoLifecycleState,
} from './so-line-export-columns';
import { soRowStatus, statusFor } from '../../../pages/scm-v2/so-list-status';
import { soStatusDisplay } from './so-status';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/lib/so-line-export-columns.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/so-line-export-columns.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/lib/so-line-export-columns.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('the labels are AutoCount captions', () => {
  test('AutoCount layout "SALES ORDER DETAILS-SALES", in its order', () => {
    expect([...SO_DEFAULT_COLUMNS]).toEqual([
      'Date', 'Doc. No.', 'Ref.', 'Agent', 'Debtor Name', 'BRANDING', 'Curr. Code', 'Total', 'Location',
      'BALANCE', 'Processing Date', 'Sales Exemption Expiry Date', 'Item Group', 'Item Code',
      'Detail Description', 'Detail Description 2', 'UOM', 'Unit Price', 'Qty', 'VENUE',
    ]);
  });

  test('every label is distinct, and the ERP-only ones keep their names', () => {
    const labels = Object.values(SO_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(SO_LABELS.lineId).toBe('Line ID');
    expect(SO_LABELS.erpDocNo).toBe('ERP Doc No');
    expect(SO_LABELS.erpItemCode).toBe('ERP Item Code');
    expect(SO_LABELS.payment).toBe('PAYEMENT');
  });

  test('no estimate delivery dates on a sales document (owner 2026-09-15)', () => {
    expect(Object.values(SO_LABELS).filter((c) => /estimate/i.test(c))).toEqual([]);
  });
});

describe('money leaves sen as ringgit', () => {
  test('no sen: 12345 sen is 123.45, a rate keeps four places, blank stays blank', () => {
    expect(senToRinggit(12345, 2)).toBe(123.45);
    expect(senToRinggit(5.5, 4)).toBe(0.055);
    expect(senToRinggit('150', 2)).toBe(1.5);
    expect(senToRinggit(null, 2)).toBeNull();
    expect(senToRinggit('', 2)).toBeNull();
  });
});

describe('the Status word is the list pill', () => {
  const stored = Object.keys(SO_STATUS_WORDS);
  const deliveries: Array<SoDeliveryState | null> = [null, 'none', 'partial', 'full'];
  const lifecycles: Array<SoLifecycleState | null> = [null, 'none', 'delivered', 'invoiced', 'returned'];

  test('every stored word is the word the list map shows', () => {
    for (const s of stored) expect(SO_STATUS_WORDS[s], s).toBe(statusFor(s).label);
  });

  test('for every status x delivery state x lifecycle, it says what soRowStatus says', () => {
    for (const status of [...stored, 'SOMETHING_NEW']) {
      for (const d of deliveries) {
        for (const l of lifecycles) {
          const onScreen = soRowStatus({ status, delivery_state: d, lifecycle_state: l }, soStatusDisplay).label;
          expect(soListStatusWord(status, d, l, false), `${status}/${d}/${l}`).toBe(onScreen);
        }
      }
    }
  });

  test('a held order keeps its word and says it is held, once', () => {
    expect(soListStatusWord('CONFIRMED', 'partial', 'delivered', true)).toBe('Partially Delivered (On Hold)');
    expect(soListStatusWord('ON_HOLD', null, null, true)).toBe('On Hold');
    expect(soListStatusWord(null, null, null, false)).toBeNull();
  });
});
