// node --test scripts/check-no-cjk-ui.test.mjs — the English-only guard's own logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCjkLiterals, isSkippedFile } from './check-no-cjk-ui.mjs';

test('finds CJK in JSX text, string literals and template pieces', () => {
  const src = [
    'const a = "入账";',
    'const b = `Total ${n} 笔`;',
    'export const C = () => <h4>From the books · 入账</h4>;',
    'const d = <input placeholder="搜索" />;',
  ].join('\n');
  const hits = findCjkLiterals('x.tsx', src).map((h) => [h.line, h.text]);
  assert.deepEqual(hits, [[1, '入账'], [2, '笔'], [3, 'From the books · 入账'], [4, '搜索']]);
});

test('ignores comments, which quote the owner and stay', () => {
  const src = '// owner: 入账\n/* 补正式单 */\nconst a = "Booked"; /** 中文 */\nconst b = <div>{/* 入账 */}OK</div>;';
  assert.deepEqual(findCjkLiterals('x.tsx', src), []);
});

test('ignores English-only text and non-CJK symbols', () => {
  assert.deepEqual(findCjkLiterals('x.ts', 'const a = "① The bill — ✓ → RM 1,000";'), []);
});

test('skips test files and type declarations', () => {
  assert.equal(isSkippedFile('pages/X.test.tsx'), true);
  assert.equal(isSkippedFile('lib/__tests__/y.ts'), true);
  assert.equal(isSkippedFile('vite-env.d.ts'), true);
  assert.equal(isSkippedFile('pages/X.tsx'), false);
});
