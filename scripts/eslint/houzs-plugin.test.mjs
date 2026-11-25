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
  ],
  invalid: [
    { code: '// add the two numbers\nconst a = 1 + 2;', errors: prose },
    { code: '// first line\n// second line\nconst a = 1;', errors: prose },
    { code: '// one\nconst a = 1;\n// two\nconst b = 2;', errors: [...prose, ...prose] },
    { code: '/* explain\n   the thing */\nconst a = 1;', errors: prose },
    { code: '/** Not exported, so it is prose. */\nfunction f() {}', errors: prose },
    { code: 'const a = 1; // trailing note', errors: prose },
    { code: '// see HC-0257 for why', errors: prose },
    { code: '// eslint-disable-next-line no-console\nconsole.log(1);', errors: [{ messageId: 'directiveWithoutReason' }] },
    { code: '// @ts-expect-error', errors: prose },
    { code: '// @ts-ignore', errors: prose },
    { code: '// why\n// eslint-disable-next-line no-console -- banner\n// more why\nx();', errors: [...prose, ...prose] },
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
