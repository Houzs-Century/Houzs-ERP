## The last two naked prompts: 2FA disable and POS PIN entry spoke in the browser's voice [low]

<!-- area: Frontend + mobile -->

**Symptom.** Two actions in the Houzs main app still raised the operating
system's raw `window.prompt` box — unstyled, un-themed, wearing the browser's
chrome — where the rest of the app raises the styled in-app dialog:

- **Profile → Two-Factor Authentication → Disable** (`Profile.tsx:500`): the
  code-or-backup-code gate before turning 2FA off.
- **Team → member row → Set POS PIN** (`Team.tsx:880`): the admin typing a
  member's 6-digit POS PIN.

Worse than cosmetic on the first one: a native prompt is suppressed inside an
installed PWA and in several webviews — the exact reason
`mobile/MobileTwoFactorCard.tsx` was built as an inline field — so in an
installed desktop PWA the 2FA **disable** path could silently do nothing.

**Root cause (traced).** The 2026-08-25 scm-v2 sweep (PR #2706; its sibling
entry `0532-cancel-po-spoke-in-the-browser-s-voice-thirteen-scm-screens.md`)
fixed
the class inside the three SCM trees and pinned it there with an ESLint gate —
and its "Out of scope, noted" paragraph names these two sites: they live in the
Houzs main app, whose dialog system is `hooks/useDialog.tsx`
(`DialogProvider` + promise-based `confirm()`/`prompt()`), not the vendored
SCM providers, so the sweep and its gate deliberately excluded them. `Team.tsx`
even already held `const dialog = useDialog()` and used `dialog.prompt` for the
disable-member reason a screen further down — only `setPosPin` still went
native. `Profile.tsx` had never imported the hook.

**Fix.** Both sites now go through `useDialog().prompt` (`DialogProvider` is
mounted at the app root in `main.tsx:252`, above both routes — verified, not
assumed): the 2FA disable as a danger-toned required prompt ("Turn off"), the
POS PIN as a required prompt ("Set PIN") keeping the existing `/^\d{6}$/`
validation and toast. The stale cross-reference in `MobileTwoFactorCard.tsx`'s
header (which documented the desktop gate as "a `window.prompt`") is updated.

Pinned the same way as the sibling: `no-restricted-properties` +
`no-restricted-globals` on `window.confirm/alert/prompt` at **error** level
(outside the ratchet) in `frontend/eslint.config.mjs`, scoped to
`src/**/*.{ts,tsx}` MINUS the three SCM trees — those carry the sweep's own
gate with messages pointing at the vendored components, and
`vendor/scm/lib/dialog-service.ts`'s pre-mount fallback stays legal inside
them. The messages here point at `hooks/useDialog` instead. Proved RED on the
unfixed tree: exactly 2 errors, at `Profile.tsx:500` and `Team.tsx:880`, out
of 959 files linted; green after, with per-rule warning totals unchanged at
their ceilings (530/784/1767/133) — no new warning debt.

**Ref.** `fix/main-app-naked-window-prompt`, 2026-08-25.
