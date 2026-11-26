import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { houzsPlugin } from './houzs-plugin.mjs';

const { RuleTester } = createRequire(import.meta.url)('../../backend/node_modules/eslint');
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
const prose = [{ messageId: 'prose' }];

tester.run('no-prose-comments', houzsPlugin.rules['no-prose-comments'], {
  valid: [
    '// eslint-disable-next-line no-console -- startup banner\nconsole.log(1);',
    '/* eslint-disable no-console -- CLI script */',
    '// eslint-enable no-console',
    '/* global window */',
    '// @ts-expect-error the vendored type is wrong',
    '// @ts-ignore: upstream typing bug',
    '/// <reference types="vite/client" />',
    '// prettier-ignore\nconst m = [1,0,0,1];',
    'const x = /*#__PURE__*/ make();',
    'import(/* @vite-ignore */ url);',
    'import(/* webpackChunkName: "x" */ "./x");',
    '/* c8 ignore next */',
    '/* istanbul ignore next */',
    '/* v8 ignore start */',
    '/*! lib v1 | MIT */',
    '/* Copyright (c) 2024 Someone */',
    '/** Total of the invoice lines. */\nexport function total() {}',
    '// https://example.com/spec#section',
    '// HC-0257',
    '// HK-0036, #1234',
    '// shortcut: one company only, upgrade when a second one signs up',
    '// @vitest-environment jsdom',
    '/**\n * Renders the list.\n * @vitest-environment jsdom\n */',
    '/** @jsxImportSource preact */',
    '// @ts-check',
    'const o = {\n  /** @deprecated use b */\n  a: 1,\n};',
    '// see HC-0257 for why',
    '// regression for docs/bugs/0806',
    '// owner 2026-11-03: keep the blast radius he approved',
    '// fixed in #6049',
    '// company-scope: reads the global price list',
    '/* company-scope-file: the queue table has no company_id */',
    '// SCOPED by parent. company-scope: the SO read above is scoped',
    '// mirror-ok: cellEdges - type annotation only',
    '/* silent-write-ok: heartbeat */',
    '// @vitest-project light',
    '// @generated',
    '// owner 2026-11-03: keep the blast radius\n// he approved, not the wider one\nconst a = 1;',
    '// why this reads twice\n// company-scope: the queue table has no company_id\nconst a = 1;',
  ],
  invalid: [
    { code: '// add the two numbers\nconst a = 1 + 2;', output: 'const a = 1 + 2;', errors: prose },
    { code: '// first line\n// second line\nconst a = 1;', output: 'const a = 1;', errors: prose },
    { code: '// one\nconst a = 1;\n// two\nconst b = 2;', output: 'const a = 1;\nconst b = 2;', errors: [...prose, ...prose] },
    { code: '/* explain\n   the thing */\nconst a = 1;', output: 'const a = 1;', errors: prose },
    { code: '/** Not exported, so it is prose. */\nfunction f() {}', output: 'function f() {}', errors: prose },
    { code: 'const a = 1; // trailing note\nconst b = 2;', output: 'const a = 1;\nconst b = 2;', errors: prose },
    { code: 'return/* gap */x;', output: 'return x;', errors: prose, languageOptions: { sourceType: 'script', parserOptions: { ecmaFeatures: { globalReturn: true } } } },
    { code: 'f(a /* note */, b);', output: 'f(a, b);', errors: prose },
    { code: '// UTF-8 bytes here', output: '', errors: prose },
    { code: '// HC-0257\n\n// unrelated note\nconst a = 1;', output: '// HC-0257\n\nconst a = 1;', errors: prose },
    { code: '// see HC-0257\nconst a = 1; // trailing note', output: '// see HC-0257\nconst a = 1;', errors: prose },
    { code: '// the row owner can edit this', output: '', errors: prose },
    { code: '// pr-12 and hc-3 in lower case', output: '', errors: prose },
    { code: `// ${'https://a.example/x, '.repeat(30)}and words`, output: '', errors: prose },
    { code: '// eslint-disable-next-line no-console\nconsole.log(1);', output: null, errors: [{ messageId: 'directiveWithoutReason' }] },
    { code: '// @ts-expect-error\nx();', output: null, errors: [{ messageId: 'directiveWithoutReason' }] },
    { code: '// @ts-ignore\nx();', output: null, errors: [{ messageId: 'directiveWithoutReason' }] },
    { code: '// why\n// eslint-disable-next-line no-console -- banner\n// more why\nx();', output: '// eslint-disable-next-line no-console -- banner\nx();', errors: [...prose, ...prose] },
    { code: 'const v = <div>\n  {/* heading */}\n  <h1 />\n</div>;', output: 'const v = <div>\n  <h1 />\n</div>;', errors: prose, languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
    { code: 'const v = <p>{/* x */}hi</p>;', output: 'const v = <p>hi</p>;', errors: prose, languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  ],
});

tester.run('no-imperative-timers', houzsPlugin.rules['no-imperative-timers'], {
  valid: [
    'clearTimeout(id);',
    'useQuery({ queryKey: ["x"], refetchInterval: 5000 });',
    'obj.setTimeout(fn, 1);',
    'window["setTimeout"](fn, 1);',
  ],
  invalid: [
    { code: 'setInterval(poll, 5000);', errors: [{ messageId: 'setInterval' }] },
    { code: 'window.setInterval(poll, 5000);', errors: [{ messageId: 'setInterval' }] },
    { code: 'setTimeout(refresh, 100);', errors: [{ messageId: 'setTimeout' }] },
    { code: 'globalThis.setTimeout(refresh, 100);', errors: [{ messageId: 'setTimeout' }] },
    { code: 'self.setTimeout(refresh, 100);', errors: [{ messageId: 'setTimeout' }] },
    { code: 'await new Promise(r => setTimeout(r, 500));', errors: [{ messageId: 'sleep' }] },
    { code: 'await new Promise((resolve) => { window.setTimeout(resolve, ms); });', errors: [{ messageId: 'sleep' }] },
    {
      code: 'new Promise((_, reject) => setTimeout(() => reject(new Error("t")), 5000));',
      errors: [{ messageId: 'setTimeout' }],
    },
  ],
});
