import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

type RecoveryContract = {
  file: string;
  state: string;
  detailPath: RegExp;
  retryLabel: string;
  openLabel: string;
};

const contracts: RecoveryContract[] = [
  {
    file: 'SalesOrderNew.tsx',
    state: 'createdDocNo',
    detailPath: /if \(intents\.length === 0\) \{\s*navigate\(`\/scm\/sales-orders\/\$\{createdDocNo\}`\);/,
    retryLabel: 'Continue payment retry',
    openLabel: 'Open created order',
  },
  {
    file: 'SalesInvoiceNew.tsx',
    state: 'createdInvoice',
    detailPath: /if \(intents\.length === 0\) \{\s*navigate\(`\/scm\/sales-invoices\/\$\{createdInvoice\.id\}`\);/,
    retryLabel: 'Continue payment retry',
    openLabel: 'Open created invoice',
  },
];

describe.each(contracts)('$file created-document recovery contract', (contract) => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/scm-v2', contract.file), 'utf8');

  test('hides the editable document form while keeping PaymentsTable available', () => {
    const hiddenFormStart = source.indexOf(`{!${contract.state} && (<>`);
    const hiddenFormEnd = source.indexOf('</>)}', hiddenFormStart);
    const paymentsTable = source.indexOf('<PaymentsTable', hiddenFormEnd);

    expect(hiddenFormStart).toBeGreaterThan(-1);
    expect(hiddenFormEnd).toBeGreaterThan(hiddenFormStart);
    expect(paymentsTable).toBeGreaterThan(hiddenFormEnd);

    const hiddenForm = source.slice(hiddenFormStart, hiddenFormEnd);
    expect(hiddenForm).toContain('>Customer<');
    expect(hiddenForm).toContain('Line Items');
    expect(hiddenForm).not.toContain('<PaymentsTable');
  });

  test('uses recovery-specific actions and lets an empty retry open Detail', () => {
    expect(source).toContain(contract.retryLabel);
    expect(source).toContain(contract.openLabel);
    expect(source).toMatch(contract.detailPath);
  });
});
