/* Finance's typed words in UPPER CASE (owner 2026-11-09: 「可以默认区别自动大写吗？不然感觉
   有些大写，有些小写，主要是finance 模块，这点可以确定」 → 做). The database upper-cases the
   typed columns (migration 20261109T1500); the screen shows a field marked data-upper in
   upper case while it is typed (index.css). Pinned:
     • the rule, and that it leaves the hint text alone;
     • the shared pay-to fields mark the bank and the account name, not the number;
     • every Finance form field whose column the database upper-cases carries the mark,
       so a rewrite cannot quietly drop it — and the fields it does not (email, codes)
       stay unmarked. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { PvPayToFields } from './PvPayToFields';

const SRC = resolve(__dirname, '../..');
const source = (file: string) => readFileSync(resolve(SRC, file), 'utf8');

describe('Finance typed words in upper case', () => {
  test('a field marked data-upper shows upper case; its hint keeps its own case', () => {
    const css = source('index.css');
    expect(css).toContain('input[data-upper], textarea[data-upper] { text-transform: uppercase; }');
    expect(css).toContain('input[data-upper]::placeholder, textarea[data-upper]::placeholder { text-transform: none; }');
  });

  test('the pay-to fields mark the bank and the account name, not the account number', () => {
    render(<PvPayToFields value={{ bank: '', accountNo: '', accountName: '' }} onChange={() => undefined} />);
    expect(screen.getByLabelText('Bank').hasAttribute('data-upper')).toBe(true);
    expect(screen.getByLabelText('Account name').hasAttribute('data-upper')).toBe(true);
    expect(screen.getByLabelText('Account no.').hasAttribute('data-upper')).toBe(false);
  });

  /* Each form, and the fields in it that carry the mark (the text right after `data-upper`). */
  const MARKED: Array<[string, string[]]> = [
    ['pages/scm-v2/PaymentVoucherNew.tsx', ['type="text" value={payeeName}', 'value={notes}', 'className={styles.fieldInput} value={officialNote}', 'type="text" value={l.description}']],
    ['pages/scm-v2/PaymentVoucherDetail.tsx', ['type="text" value={payeeName}', 'value={notes}', 'type="text" value={l.description}']],
    ['pages/scm-v2/PvTextEdit.tsx', ['value={text}', "type=\"text\" value={lineText[l.id] ?? ''}"]],
    ['pages/scm-v2/ApInvoiceForm.tsx', ["className={styles.fieldInput} value={v.officialDocNote ?? ''}", 'className={styles.fieldInput} value={v.description}', "className={styles.fieldInput} style={{ width: '100%' }} placeholder=\"Description\""]],
    ['pages/scm-v2/PaymentRequestForm.tsx', ['className={styles.fieldInput} value={v.payeeName}', "className={styles.fieldInput} value={v.bankName ?? ''}",
      "className={styles.fieldInput} value={v.bankAccountName ?? ''}", 'className={styles.fieldInput} rows={2} value={v.purpose}',
      'className={styles.fieldInput} value={noEventReason}', "className={styles.fieldInput} rows={3} value={v.note ?? ''}"]],
    ['pages/scm-v2/PaymentRequestParts.tsx', ['className={styles.fieldInput} value={purpose}']],
    ['pages/scm-v2/PaymentRequestsFinance.tsx', ['ref={input} className={look.backInput} value={note}']],
    ['pages/scm-v2/money-in/ReceiptForm.tsx', ['value={v.payerName}', 'placeholder="What it is for" value={l.description}']],
    ['pages/scm-v2/JournalEntryCards.tsx', ['className={s.input} placeholder="What is this entry?"', 'className={s.input} placeholder="Optional"']],
    ['pages/scm-v2/CreditNotes.tsx', ['value={v.partyName}', 'value={v.reason}', 'value={l.description}']],
    ['pages/scm-v2/DebtorBillForm.tsx', ['className={ui.formInput} value={v.notes}', 'className={ui.formInput} placeholder="What it is for"']],
    ['vendor/scm/components/OrderMoneyPanel.tsx', ['value={value.bankName}', 'value={value.bankAccountName}', 'value={reason}']],
    ['mobile/MobilePaymentRequests.tsx', ['className="cal-sel" aria-label="Pay to"', 'className="cal-sel" aria-label="Payee\'s bank"', 'className="cal-sel" aria-label="Account name"',
      'className="cal-sel" rows={2} aria-label="What is it for"', 'className="cal-sel" aria-label="Why there is no event"', 'className="cal-sel" rows={3} aria-label="Note"',
      'className="cal-sel" aria-label="Balance purpose"']],
  ];
  test.each(MARKED)('%s marks the fields the database upper-cases', (file, fields) => {
    const text = source(file);
    for (const field of fields) expect(text, field).toMatch(new RegExp(`<(input|textarea) data-upper ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('the supplier form marks its name and bank, not its email or code; the debtor form its name only', () => {
    const supplier = source('pages/scm-v2/SupplierMaintenance.tsx');
    expect(supplier).toContain("const UPPER_FIELDS: ReadonlySet<string> = new Set(['name', 'bankName', 'bankAccountName']);");
    expect(supplier).toContain("data-upper={UPPER_FIELDS.has(k) ? '' : undefined}");
    expect(source('pages/scm-v2/money-in/DebtorForm.tsx')).toContain("data-upper={key === 'name' ? '' : undefined}");
  });
});
