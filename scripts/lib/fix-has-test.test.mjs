// The gate's own tests. A checker that cannot match reports a clean run, so the
// patterns are pinned here and the workflow runs this file before the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isProductCode, isTestFile, looksLikeFix, verdict, WAIVER_LABEL } from './fix-has-test.mjs';

test('a fix is the conventional prefix or a fix/ branch, nothing looser', () => {
  assert.equal(looksLikeFix('fix(so): the lock is released', 'x'), true);
  assert.equal(looksLikeFix('fix: the lock is released', 'x'), true);
  assert.equal(looksLikeFix('anything', 'fix/lock-release'), true);
  assert.equal(looksLikeFix('anything', 'hotfix/lock'), true);
  assert.equal(looksLikeFix('feat(so): a panel that also fixes the lock', 'feat/panel'), false);
  assert.equal(looksLikeFix('chore: prefix mentions fix', 'chore/x'), false);
});

test('product code is src, and a test under src is not product code', () => {
  assert.equal(isProductCode('backend/src/scm/routes/mfg-sales-orders.ts'), true);
  assert.equal(isProductCode('frontend/src/pages/Projects.tsx'), true);
  assert.equal(isProductCode('frontend/src/auth/capabilities.test.ts'), false);
  assert.equal(isProductCode('backend/scripts/repair-x.mjs'), false);
  assert.equal(isProductCode('docs/modules/sales-order.md'), false);
});

test('a test is a tests folder, a .test./.spec. name, or e2e', () => {
  assert.equal(isTestFile('backend/tests/soPayments.test.ts'), true);
  assert.equal(isTestFile('backend/tests-pg/x.pg.test.ts'), true);
  assert.equal(isTestFile('frontend/src/lib/money.spec.ts'), true);
  assert.equal(isTestFile('e2e/checkout.ts'), true);
  assert.equal(isTestFile('backend/src/acc/receipts.ts'), false);
});

test('a fix that changes product code with no test is the only failing shape', () => {
  const files = ['backend/src/acc/receipts.ts'];
  assert.equal(verdict({ title: 'fix(acc): scope the receipt', branch: 'fix/receipt', files, labels: [] }).ok, false);
  assert.equal(verdict({ title: 'fix(acc): scope the receipt', branch: 'fix/receipt', files: [...files, 'backend/tests/officialReceipts.test.ts'], labels: [] }).ok, true);
  assert.equal(verdict({ title: 'feat(acc): receipts', branch: 'feat/receipts', files, labels: [] }).ok, true);
  assert.equal(verdict({ title: 'fix(docs): typo', branch: 'fix/typo', files: ['docs/modules/accounting.md'], labels: [] }).ok, true);
  assert.equal(verdict({ title: 'fix(ci): workflow', branch: 'fix/ci', files: ['.github/workflows/ci.yml'], labels: [] }).ok, true);
});

test('the waiver label is honoured and named in the verdict', () => {
  const v = verdict({
    title: 'fix(acc): scope the receipt',
    branch: 'fix/receipt',
    files: ['backend/src/acc/receipts.ts'],
    labels: ['Something', WAIVER_LABEL.toUpperCase()],
  });
  assert.equal(v.ok, true);
  assert.equal(v.waived, true);
  assert.match(v.reason, new RegExp(WAIVER_LABEL));
});
