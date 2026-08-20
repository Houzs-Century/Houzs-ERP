/* Scanning a COLLEAGUE'S slip on the phone must be able to name the colleague.

   ── THE BUG ────────────────────────────────────────────────────────────────
   Desktop's Scan Order modal defaults the salesperson to whoever is signed in —
   the usual case — and keeps it EDITABLE, backed by `GET /scan-so/salespeople`,
   "for the occasional someone-else slip" (`ScanOrderModal.tsx`). Mobile had

       const salesperson = (user?.name || user?.email || "").trim();

   — a `const`, no setter, no list — and that one value is what rides both
   `/scan-so/extract` and `/scan-so/enqueue`.

   ── WHAT IT DECIDES, traced rather than assumed ─────────────────────────────
   The rep name is the OCR LEARNING KEY: the backend loads THAT rep's distilled
   rules and few-shot examples to read the slip
   (`scan-so.ts` `loadPromptInjections(svc, job.salesperson)`), files the
   resulting `so_scan_samples` row under that name, and filters the Recent-scans
   list by it. So the office person working through a stack of colleagues' slips
   read every one against their own handwriting habits and taught their
   colleagues' corrections into their own rule file.

   It is NOT the SO's `salesperson_id`. That is stamped server-side from the
   authed caller (`resolveScanUploaderStaffId`, `scan-so.ts:4270` →
   `scan_jobs.salesperson_id`) and is deliberately not caller-trusted, on BOTH
   surfaces. Naming this a commission fix would be a claim the tree does not
   support.

   ── SOURCE TEXT WHERE A RENDER WOULD PAPER OVER IT ──────────────────────────
   `MobileScan` is a camera screen behind a dozen catalog queries; what matters
   here is whether the value is a CONSTANT or a piece of state, and whether the
   list the desktop offers is fetched at all. Same idiom as
   `vendor/scm/lib/so-slip-optional-contract.test.ts`. The list normaliser it
   now shares with desktop is unit tested for real below. */

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
    /* The datalist is a convenience — the field stays free-text either way, and
       a hiccup here must not take the scan screen down with it. */
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
    /* Both scan POSTs carry it: /extract (per-slip OCR, rep-specific rules) and
       /enqueue (the background path that mints the draft server-side). If either
       one stopped reading `salesperson`, the correction would not travel. */
    expect(mobileSource).toContain('form.append("salesperson", salesperson)');
  });

  test('desktop still defaults to the signed-in user and stays editable', () => {
    expect(desktopSource).toContain('useState(() => user?.name ?? \'\')');
    expect(desktopSource).toContain('setSalesperson');
  });
});
