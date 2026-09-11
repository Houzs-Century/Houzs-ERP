## Mobile Assistant removed entirely — owner does not want it on mobile [low]

**Symptom.** Owner 2026-09-11, on the mobile New / Edit Sales Order form:
the Assistant sat right below "Create Sales Order" and "Save draft" —
its "Ask about your ops" title, prompt-suggestion chips and compose
input added half a screen of unrelated UI beneath the primary CTA. On
the follow-up the owner escalated: 「那个 assistant 的功能是直接不要
的，你可以直接 backend 删除了，不用 load 出来」 — do not just hide it
here, do not load it at all on mobile.

**Root cause (traced).** `MobileAssistant` was mounted UNCONDITIONALLY
at `frontend/src/mobile/MobileApp.tsx:461` as a sibling of `MobileAppInner`,
above the tree that owns the `screen` state, so it appeared on every
screen with no per-screen gate. The Assistant's launcher is fixed at
`bottom + 86px` (its own sheet drops from the same origin), so on any
screen it will float over the current UI.

**Fix.** Removed the mount entirely from `MobileApp.tsx` (import
commented, `<MobileAssistant />` line dropped). No launcher, no sheet,
no `/api/assistant` calls fire on mobile.

Component + backend service kept in place:
- `frontend/src/mobile/MobileAssistant.tsx` (unused import there)
- `frontend/src/pages/Assistant.tsx` (desktop page at `/assistant`)
- `frontend/src/components/useAssistantChat.ts` (still used by desktop)
- `backend/src/services/assistant*.ts` (five files — assistant,
  assistant-tools, assistant-teach, assistant-history, assistant-scope)
- The DB tables that back conversation history

Owner asked about "backend delete too". Full removal of those needs a
separate decision (dropping the tables loses stored conversations; the
desktop `/assistant` page still uses them). Raised as a follow-up ask;
not done here so this ship is minimal and reversible.

**Ref.** `fix/hide-assistant-on-new-so`, 2026-09-11.
