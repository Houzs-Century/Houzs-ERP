## Cancel PO spoke in the browser's voice — thirteen SCM screens still ran native confirms [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Clicking **Cancel PO** on `/scm/purchase-orders/<id>` (company 2990,
prod, 2026-08-24) popped the operating system's raw `window.confirm` box —
unstyled, un-themed, wearing the browser's chrome instead of the app's — where
every neighbouring action ("Send to supplier" on the SAME toolbar) raises the
styled in-app dialog. Reproduced twice in two fresh tabs.

**Root cause (traced).** Not the suspected one. The initial diagnosis blamed
`dialog-service.ts`'s pre-mount fallback ("the dialog host isn't mounted on that
route"), and it does not survive contact with the tree: the route wraps its page
in `<Scm2990Shell>` (App.tsx), which mounts `ConfirmProvider` and registers
`<DialogServiceBridge>` — the host IS there, and the vendored `useConfirm()`
*throws* without a provider rather than falling back, so a missing host would
have been a white page, not a native box.

The real defect is dumber: `PurchaseOrderDetailV2.tsx`'s `doCancel` (and
`doConfirm`, `doReopen`) called `window.confirm(...)` directly — in a component
that already held `const confirm = useConfirm()` and used it four handlers up
for the supplier email. The read-only V2 page is what renders without `?edit=1`;
the `?edit=1` editor (`PurchaseOrderDetail.tsx`) always used the in-app
`askConfirm`, which is why editing felt right and cancelling felt foreign.

The audit the misdiagnosis asked for found the class: **25 naked
`window.confirm` / `window.prompt` calls across 14 scm-v2 files**, every one of
them inside `Scm2990Shell` with the providers sitting right there — the V2
redesigns (GRN post/cancel on detail AND list, PI mark-paid/confirm/cancel on
detail AND list, PO cancel on the list, PR post/complete/cancel on detail AND
list, DO cancel, DR cancel, SO cancel + unsaved-payments leave gate, stock
transfer/take cancels, and `use-hold-action.ts`, whose header comment explicitly
justified native "to match the neighbouring Cancel prompts" — a rationale this
sweep inverts).

**Fix.** All 25 sites now go through the vendored in-app dialogs: `useConfirm()`
with title / body / confirmLabel split (danger red on every destructive cancel),
`usePrompt()` for the purchase-return credit-note reference (optional field —
empty Confirm still completes, only Cancel aborts, mirroring the old
`window.prompt` contract). `useHoldAction` consumes its own `holdPrompt` copy —
the words that must not drift now render in the dialog they were written for.

Pinned by ESLint, not a regex scan: `no-restricted-properties` +
`no-restricted-globals` on `window.confirm/alert/prompt` at **error** level
(outside the ratchet, same shape as `rules-of-hooks` — a new violation is
operator-facing on its first appearance) scoped to `src/pages/scm-v2/**`,
`src/components/scm-v2/**`, `src/vendor/scm/**`, with the one designed
exemption: `vendor/scm/lib/dialog-service.ts`, whose pre-mount fallback exists
so a prompt is never silently dropped. AST-based, so the many comments that
mention `window.confirm` cannot trip it — the strip-comments trap of regex
guards does not exist here. Proved RED on the unfixed tree (25 errors, 118
pre-existing warnings), green after (0 errors, the same 118 warnings — the
sweep adds no warning debt).

**Out of scope, noted.** `Profile.tsx:500` and `Team.tsx:880` still
`window.prompt` — they live in the Houzs main app, which has its own
`DialogProvider` (`hooks/useDialog.tsx`, with a `prompt()`), not the vendored
SCM providers, so they are a separate small sweep.

**Ref.** `fix/scm-native-confirm-sweep`, 2026-08-25.
