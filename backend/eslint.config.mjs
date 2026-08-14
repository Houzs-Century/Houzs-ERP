// ----------------------------------------------------------------------------
// ESLint 9 flat config — backend.
//
// Run it with `npm run lint`, NOT with a bare `npx eslint`. The bare command
// exits 0 on warnings, and every rule here is a warning by design (see
// ../scripts/eslint/houzs-lint-rules.mjs). `npm run lint` runs
// ../scripts/lint-ratchet.mjs, which is the actual gate: a per-file ceiling that
// may only fall.
//
// TYPE-AWARE, deliberately. The rule this repo most needs
// (no-unnecessary-condition — a `??` on something never nullish, a `?.` on a
// value the type says is present) cannot be written as a regex or a node script,
// and `tsc --noEmit` does not report it. Type information is the whole reason
// ESLint is here rather than a twelfth `scripts/check-*.mjs`.
//
// SCOPE: `src/**/*.ts` only — the code that ships. `scripts/` is .mjs with no
// tsconfig, and `tests/` is outside backend/tsconfig.json's `include`, so
// neither can be type-checked by the parser without inventing a second project.
// ----------------------------------------------------------------------------
import tseslint from 'typescript-eslint';
import { sharedRules } from '../scripts/eslint/houzs-lint-rules.mjs';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.wrangler/**',
      'scripts/**',
      'tests/**',
      'drizzle/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // There are 514 `eslint-disable` comments in backend/src + frontend/src
      // and this repo has never had a linter, so essentially all of them are
      // unused. Reporting them would bury the four rules that matter under
      // several hundred findings on the first run. Left off until the layer has
      // earned its keep; the directives themselves are harmless.
      reportUnusedDisableDirectives: 'off',
    },
    rules: sharedRules,
  },
  {
    // `scm/shared/do-shipped-states.ts` IS the declaration the do-status
    // selector points at, and `scm/lib/finance-keys.ts` IS the finance
    // vocabulary. They are allowed to spell the lists out; that is their job.
    files: [
      'src/scm/shared/do-shipped-states.ts',
      'src/scm/lib/finance-keys.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
