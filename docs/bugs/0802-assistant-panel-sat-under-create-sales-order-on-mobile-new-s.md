## Assistant panel sat under "Create Sales Order" on mobile New SO [low]

**Symptom.** Owner 2026-09-11: on the mobile New / Edit Sales Order form,
the Assistant sat right below the "Create Sales Order" and "Save draft"
buttons — its "Ask about your ops" title, prompt-suggestion chips and
compose input added a half-screen of unrelated UI beneath the primary
CTA. The operator was here to create an order, not to ask the Assistant
anything.

**Root cause (traced).** `MobileAssistant` was mounted UNCONDITIONALLY
at `frontend/src/mobile/MobileApp.tsx:461` as a sibling of `MobileAppInner`
— above the tree that owns the `screen` state — so it appeared on every
screen with no per-screen gate. The New-SO overlay does not itself hide
it, and the Assistant's launcher is fixed at `bottom + 86px` (its own
sheet drops from the same origin), so the two surfaces stack.

**Fix.** Add a `hidden?: boolean` prop to `MobileAssistant` (returns
`null` when true) and move the mount into `MobileAppInner`'s return —
where the `screen` state lives — passing `hidden={screen.t === "new-so"}`.
Every other screen keeps the Assistant. Two small edits, no context
plumbing, no refactor of MobileAppInner's screen state upward. Typecheck
clean.

**Ref.** `fix/hide-assistant-on-new-so`, 2026-09-11.
