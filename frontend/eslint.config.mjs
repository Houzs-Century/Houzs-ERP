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
      // Registered so the 97 `eslint-disable-next-line react-hooks/…`
      // directives already in src/ — written against a plugin this repo never
      // installed — do not each fail with "Definition for rule … was not
      // found", which is a hard error and would make the job red on 97 comments
      // rather than on any code.
      'react-hooks': reactHooks,
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      ...sharedRules,
      // ON at error level since 2026-08-17. This is a CORRECTNESS rule, not a
      // style one: a hook called after a conditional `return` runs on the
      // loaded render and not on the loading one, so React throws
      // "Rendered more hooks than during the previous render" (minified #310)
      // and the whole page dies. Ten components were in that state — three of
      // them confirmed crashing in production on a direct URL / refresh of a
      // Purchase Order, Purchase Invoice or Goods Receipt (arriving from the
      // list hid it, because react-query already had the detail cached so the
      // isPending branch never rendered first).
      //
      // `error`, not `warn`, and deliberately outside the ratchet: the ratchet
      // counts warnings per file and lets existing ones sit at their ceiling,
      // which is the right shape for style debt and the wrong one for a rule
      // whose every violation is a page that crashes. A new violation must fail
      // the build on its first appearance, in any file, ceiling or not.
      'react-hooks/rules-of-hooks': 'error',
      // Left OFF on purpose — noisy, and a missing dep is a stale value, not a
      // crash. Separate piece of work with its own evidence.
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    /* Native browser prompts are BANNED in the SCM tree (2026-08-24). Every
       /scm/* route mounts ConfirmProvider / PromptProvider / NotifyProvider via
       Scm2990Shell, so the styled in-app dialogs are always available — yet
       operators were still getting a raw OS `window.confirm` on Cancel PO /
       Post GRN / Cancel invoice, because thirteen V2 pages never migrated
       (docs/bugs entry of the same date). Commander's rule is "no 裸奔": use
       useConfirm / usePrompt / useNotify. `error` and outside the ratchet for
       the same reason rules-of-hooks is: every violation is operator-facing on
       its first appearance, so it must fail the build, not sit at a ceiling.
       AST-based, so the many comments that MENTION window.confirm don't trip it
       (the regex guards' strip-comments trap does not exist here). */
    files: ['src/pages/scm-v2/**/*.{ts,tsx}', 'src/components/scm-v2/**/*.{ts,tsx}', 'src/vendor/scm/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'window', property: 'confirm', message: 'Use useConfirm() from vendor/scm/components/ConfirmDialog — the provider is mounted by Scm2990Shell on every /scm/* route.' },
        { object: 'window', property: 'alert', message: 'Use useNotify() from vendor/scm/components/NotifyDialog.' },
        { object: 'window', property: 'prompt', message: 'Use usePrompt() from vendor/scm/components/PromptDialog.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'confirm', message: 'Use useConfirm() from vendor/scm/components/ConfirmDialog.' },
        { name: 'alert', message: 'Use useNotify() from vendor/scm/components/NotifyDialog.' },
        { name: 'prompt', message: 'Use usePrompt() from vendor/scm/components/PromptDialog.' },
      ],
    },
  },
  {
    /* dialog-service.ts IS the designed pre-mount escape hatch: its
       serviceConfirm / serviceNotify fall back to window.confirm / window.alert
       only before <DialogServiceBridge> registers the live dialogs, so a prompt
       is never silently dropped. The one place the natives are the point. */
    files: ['src/vendor/scm/lib/dialog-service.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-globals': 'off' },
  },
  {
    /* The SAME BAN for the main app (2026-08-25), which the block above
       deliberately excluded: it has its own promise-based dialogs — useDialog()
       in src/hooks/useDialog.tsx, with DialogProvider mounted at the app root
       in main.tsx — so a native box is never a missing-tooling gap, only an
       unstyled regression. `error`, outside the ratchet, same shape as
       rules-of-hooks above: a new violation must fail on first appearance.

       The three SCM trees are excluded HERE because these messages would
       misdirect there — those trees use the vendored dialog components and
       carry the scoped block above, with the dialog-service.ts exemption. */
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      'src/pages/scm-v2/**',
      'src/components/scm-v2/**',
      'src/vendor/scm/**',
    ],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'window', property: 'confirm', message: 'Use useDialog().confirm from hooks/useDialog — DialogProvider is mounted at the app root in main.tsx.' },
        { object: 'window', property: 'alert', message: 'Use useToast() for notices or useDialog().confirm from hooks/useDialog.' },
        { object: 'window', property: 'prompt', message: 'Use useDialog().prompt from hooks/useDialog (supports required/inputType).' },
      ],
      'no-restricted-globals': ['error',
        { name: 'confirm', message: 'Use useDialog().confirm from hooks/useDialog.' },
        { name: 'alert', message: 'Use useToast() for notices or useDialog().confirm from hooks/useDialog.' },
        { name: 'prompt', message: 'Use useDialog().prompt from hooks/useDialog.' },
      ],
    },
  },
  {
    /* `vendor/shared/do-shipped-states.ts` IS the declaration the do-status
       selector points at — the byte-identical twin of
       backend/src/scm/shared/do-shipped-states.ts, which the backend config
       exempts by path for exactly this reason. It is allowed to spell the lists
       out; that is its job, and it is the whole point of the file existing.

       EXEMPTED BY PATH, NOT BY AN INLINE DISABLE, and that is load-bearing:
       check-shared-mirrors.mjs --strict reports this pair as IDENTICAL only
       while the two files match byte for byte. An `eslint-disable-next-line`
       comment in the frontend copy would silence the rule and simultaneously
       break the property the copy exists to have. */
    files: ['src/vendor/shared/do-shipped-states.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
