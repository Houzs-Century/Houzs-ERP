
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SCAN_SALESPEOPLE_PATH, normalizeScanSalespeople } from '../vendor/scm/lib/scan-jobs';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const mobileSource = read('src/mobile/MobileScan.tsx');
const desktopSource = read('src/vendor/scm/components/ScanOrderModal.tsx');

describe('the shared known-reps list', () => {
  test('the endpoint is named once, so the two surfaces cannot offer different lists', () => {
    expect(SCAN_SALESPEOPLE_PATH).toBe('/scan-so/salespeople');
    expect(mobileSource).toContain('SCAN_SALESPEOPLE_PATH');
    expect(desktopSource).toContain('SCAN_SALESPEOPLE_PATH');
  });

  test('normalizeScanSalespeople reads the payload and drops what cannot be a name', () => {
    expect(normalizeScanSalespeople({ data: { salespeople: ['Amy Tan', 'Ben Lim'] } }))
      .toEqual(['Amy Tan', 'Ben Lim']);
    expect(normalizeScanSalespeople({ data: { salespeople: ['  Amy Tan  ', '', '   ', 7, null] } }))
      .toEqual(['Amy Tan']);
  });

  test('a missing or malformed answer is an EMPTY list, never a throw', () => {
    expect(normalizeScanSalespeople(undefined)).toEqual([]);
    expect(normalizeScanSalespeople({})).toEqual([]);
    expect(normalizeScanSalespeople({ data: {} })).toEqual([]);
    expect(normalizeScanSalespeople('nonsense')).toEqual([]);
  });
});

describe('mobile Scan attributes the slip to whoever actually wrote it', () => {
  test('the salesperson is editable state, not a constant off the signed-in user', () => {
    expect(mobileSource, 'MobileScan still hard-codes the scanner as the salesperson')
      .not.toMatch(/const salesperson = \(user\?\.name \|\| user\?\.email \|\| ""\)\.trim\(\);/);
    expect(mobileSource, 'MobileScan has no way to change the salesperson')
      .toMatch(/\[\s*salesperson\s*,\s*setSalesperson\s*\]\s*=\s*useState/);
  });

  test('the value that rides the upload is that same editable value', () => {
    expect(mobileSource).toContain('form.append("salesperson", salesperson)');
  });

  test('desktop still defaults to the signed-in user and stays editable', () => {
    expect(desktopSource).toContain('useState(() => user?.name ?? \'\')');
    expect(desktopSource).toContain('setSalesperson');
  });
});
