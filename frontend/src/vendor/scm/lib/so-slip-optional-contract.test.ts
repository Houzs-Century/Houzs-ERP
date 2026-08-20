/* The payment slip is OPTIONAL on every Sales-Order path (Owner 2026-08-13:
   "其实 SalesOrder 所有的付款都不强制 ... 如果是 manually 填写的话,基本上不需要
   强求").

   ── WHY THIS FILE IS ABOUT WRITERS, NOT ABOUT A GUARD ───────────────────────
   Dropping the guard is one line. The reason a guard was ever there is the
   part that can kill money: BOTH create surfaces used to post only the payment
   rows that carried a slip, so a slip-less row was silently dropped, the
   cashier's payment never booked and the SO read unpaid (BUG-HISTORY, the bug
   that produced `soSliplessPaymentError` in the first place). The guard was the
   thing standing in front of that.

   So the rule these tests pin is a PAIR:
     · no surface refuses a payment for having no slip, AND
     · every amount-bearing row is posted regardless of its slip.
   Break the second half and the first half becomes the original money bug.

   Source-text assertions rather than render tests: these are 2,600- and
   3,700-line screens whose save paths are unreachable without mounting the
   whole form, and what matters is precisely WHICH predicate feeds which
   filter — exactly what the text shows and what a mocked render would paper
   over. Same idiom as payment-proof-contract.test.ts. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as soFormValidate from './so-form-validate';

const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), 'utf8');

const desktopSource = read('src/pages/scm-v2/SalesOrderNew.tsx');
const mobileSource = read('src/mobile/MobileNewSO.tsx');
const guidedSource = read('src/pages/scm-v2/SalesOrderNewGuided.tsx');
const fromProductsSource = read('src/pages/scm-v2/SalesOrderNewFromProducts.tsx');
const tableSource = read('src/vendor/scm/components/PaymentsTable.tsx');

/** Body of a top-level `function name(` / `const name =` up to the next one. */
const sliceFrom = (source: string, startAnchor: string, endAnchor: string): string => {
  const start = source.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('the shared save-guard layer carries no slip rule', () => {
  test('soSliplessPaymentError is gone, not neutered', () => {
    /* A guard that always returns null is a lie the next reader has to
       disprove. If a slip requirement ever comes back it should arrive as a
       new, named rule with the owner ruling that asked for it. */
    expect('soSliplessPaymentError' in soFormValidate).toBe(false);
  });

  test('no create surface calls one — all four move together', () => {
    for (const [name, source] of [
      ['SalesOrderNew', desktopSource],
      ['MobileNewSO', mobileSource],
      ['SalesOrderNewGuided', guidedSource],
      ['SalesOrderNewFromProducts', fromProductsSource],
    ] as const) {
      expect(source, `${name} still references a slipless guard`)
        .not.toContain('soSliplessPaymentError');
    }
  });

  test('the guards that did NOT change are still shared by all four', () => {
    /* Removing one rule must not quietly unhook the others from the shared
       layer — desktop and mobile diverging on a save guard is the recurring
       bug class named in CLAUDE.md. */
    for (const source of [desktopSource, mobileSource, guidedSource, fromProductsSource]) {
      expect(source).toContain('soDateGuardError');
      expect(source).toContain('soStockLocationError');
    }
  });
});

describe('mobile: a slip-less payment is POSTED, not dropped', () => {
  const recorder = () =>
    sliceFrom(mobileSource, 'async function recordNewPayments(', 'if (failed > 0) {');

  test('the filter is the amount, and only the amount', () => {
    expect(recorder()).toContain('const rows = pays.filter((p) => toSen(p.amount) > 0);');
  });

  test('it never filters on the slip again (the money bug)', () => {
    expect(recorder()).not.toMatch(/p\.slipSession\s*&&/);
  });

  test('a slip that IS attached still rides along', () => {
    expect(recorder()).toContain('uploadSessionId: p.slipSession || null,');
  });

  test('the create-time deposit gate counts every row the recorder will post', () => {
    /* pendingDepositSen is GATE-ONLY money. Count fewer rows than the
       recorder posts and a slip-less deposit reads RM0 against a Processing
       Date, which 422s the create — the deadlock this field exists to close. */
    const body = sliceFrom(mobileSource, 'pendingDepositSen: (() => {', 'items,');
    expect(body).toContain('.filter((p) => toSen(p.amount) > 0)');
    expect(body).not.toContain('p.slipSession');
  });

  test('the payment card no longer calls a slip-less row "planned"', () => {
    /* Two lines of copy said the money would not book without a slip — a
       per-row amber warning and the section footnote. Both were true when the
       writer filtered on the slip; both were a lie about the operator's money
       the moment it stopped. */
    expect(mobileSource).not.toContain('Planned —');
    expect(mobileSource).not.toContain('Each payment needs a slip to be recorded');
    expect(mobileSource).toContain('A slip is optional');
  });
});

describe('desktop: a slip-less payment is POSTED, not dropped', () => {
  test('the rows to post are chosen on amount (receipt-backed rows go their own way)', () => {
    expect(desktopSource).toContain(
      'const paymentIntents = () => paymentDrafts.filter((d) => d.amountSen > 0 && !d.receiptImageKey);',
    );
  });

  test('the flush sends the session as-is — null when there is none', () => {
    const flush = sliceFrom(
      desktopSource, 'const flushPaymentDrafts =', 'const results:',
    );
    expect(flush).toContain('uploadSessionId: d.slipUploadSessionId,');
    expect(flush).not.toMatch(/\.filter\([^)]*slipUploadSessionId/);
  });

  test('the create-time deposit gate counts exactly the rows the flush will post', () => {
    expect(desktopSource).toContain('const pendingDepositSen = paymentIntents()');
    const gate = sliceFrom(
      desktopSource, 'const pendingDepositSen = paymentIntents()', 'create.mutate(',
    );
    expect(gate).not.toContain('slipUploadSessionId');
  });
});

describe('the OCR / Scan-Order receipt still rides along automatically', () => {
  test('a scanned receipt is still recorded through the create body, once', () => {
    /* The receipt IS the proof (owner 2026-07-15) and reaches the deposit row
       as the header `receipt_image_key`, NOT through the per-payment slip
       session. It must stay out of paymentIntents so it is never booked twice. */
    expect(desktopSource).toContain(
      '(d) => d.amountSen > 0 && Boolean(d.receiptImageKey),',
    );
    expect(desktopSource).toContain('receiptImageKey: scanReceiptImageKey || undefined,');
    expect(desktopSource).toContain('!d.receiptImageKey');
  });

  test('a scanned row is still TAGGED with the receipt key when the modal seeds it', () => {
    /* The tag used to double as the slipless guard's exemption ("the receipt
       IS the slip"). The guard is gone, but the tag is still load-bearing: it
       is what routes the row to the create body instead of the per-payment
       post, and an untagged row would post as an ordinary payment with the
       receipt landing on nothing. */
    const seed = sliceFrom(
      desktopSource, 'if (payload.payment?.methodValue) {', 'const lineMeta:',
    );
    expect(seed).toContain('receiptImageKey:        payload.receiptImageKey');
  });

  test('the PaymentsTable draft row still carries the scanned key', () => {
    expect(tableSource).toContain('receiptImageKey?:         string;');
  });
});

describe('the UI stops marking the slip required', () => {
  test('no SlipUploadField on the SO payments table is required-marked', () => {
    const uploaders = tableSource.match(/<SlipUploadField[\s\S]{0,120}?required[^\n]*/g) ?? [];
    expect(uploaders.length).toBeGreaterThan(0);
    for (const u of uploaders) expect(u).toContain('required={false}');
  });

  test('the bare `required` prop is gone from every callsite', () => {
    /* `required` on its own line (JSX shorthand for `required={true}`) is what
       rendered the red asterisk on the New-SO draft rows. */
    expect(tableSource).not.toMatch(/\n\s+required\n/);
  });
});
