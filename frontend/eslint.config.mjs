// ----------------------------------------------------------------------------
// ESLint 9 flat config — frontend. Rule list and rationale live in
// ../scripts/eslint/houzs-lint-rules.mjs; this file only says WHERE they apply.
//
// Run it with `npm run lint`, NOT a bare `npx eslint` — see the backend config's
// header for why (warnings by design; ../scripts/lint-ratchet.mjs is the gate).
//
// SCOPE: `src/**/*.{ts,tsx}` — the app that ships. `perf-lab/`, `e2e/` and
// `scripts/` each carry their own tsconfig or none, and typed linting needs a
// project that actually includes the file.
//
// NOTE on `npm run typecheck`: it is `tsc -b`, and a bare `npx tsc --noEmit`
// here checks NOTHING and exits 0 (tsconfig.json is a solution file with
// `"files": []`). ESLint does not inherit that trap — it is pointed at
// tsconfig.app.json directly.
// ----------------------------------------------------------------------------
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { sharedRules } from '../scripts/eslint/houzs-lint-rules.mjs';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'perf-lab/**',
      'e2e/**',
      'scripts/**',
      'functions/**',
      'public/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      // REGISTERED, every rule OFF. 97 `eslint-disable-next-line react-hooks/…`
      // directives already exist in src/ — written against a plugin this repo
      // never installed. Without the plugin registered ESLint fails each of them
      // with "Definition for rule 'react-hooks/exhaustive-deps' was not found",
      // which is a hard error and would make the job red on 97 comments rather
      // than on any code. Turning the rules ON is a separate PR with its own
      // evidence; it is not smuggled in under this one.
      'react-hooks': reactHooks,
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      ...sharedRules,
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
);
