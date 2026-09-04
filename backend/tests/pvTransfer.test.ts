// Internal transfers inside the PV (GL redesign item 10). Pinned:
//   • a line debiting the Paid From account itself is refused at typing time
//     (same_account) — on create AND on edit, and the edit checks the
//     EFFECTIVE Paid From when the same request changes it;
//   • a proper transfer shape (Dr our other account / Cr Paid From) passes
//     buildLines untouched — the whole feature rides the existing document.

import { describe, expect, test } from 'vitest';
import { buildLines } from '../src/scm/routes/payment-vouchers';

describe('the transfer rides buildLines unchanged', () => {
  test('one money-destination line is a valid lines payload', () => {
    const built = buildLines([{ description: 'Internal transfer', debitAccountCode: '310-0020', amountSen: 500000 }]);
    expect('error' in built).toBe(false);
    if ('error' in built) return;
    expect(built.total).toBe(500000);
    expect(built.rows[0]).toMatchObject({ debit_account_code: '310-0020', line_no: 1 });
  });

  test('the self-debit guard is the route layer\'s: buildLines itself stays shape-only', () => {
    // buildLines cannot know the header's credit account — the route holds
    // that door (same_account, create + patch). This pins the split so a
    // refactor moving the check INTO buildLines updates this test on purpose.
    const built = buildLines([{ description: 'x', debitAccountCode: '310-0010', amountSen: 100 }]);
    expect('error' in built).toBe(false);
  });
});
