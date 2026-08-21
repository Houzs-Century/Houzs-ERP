## Fleet Health refused six writes in silence under a comment claiming a reload would show it [medium]

**Symptom.** On the Fleet Health drawer a mechanic sets a breakdown to
"Resolved" and the dropdown reads Resolved — while the case is still OPEN in the
database and the lorry is still grounded. The same silence covered the work-order
stepper, adding and removing a work-order part (which carries its cost), removing
a tyre, and logging a component event. Nothing on screen distinguished a refused
write from a saved one.

**Root cause (traced).** Six write handlers in `frontend/src/pages/FleetHealth.tsx`
swallowed their rejection with `catch { /* surfaced on reload */ }`. That comment
is a claim, and it is false: `onChanged()` — the refetch it points at — is the
LAST statement inside the `try`, so a refusal skips it. Nothing refetches,
nothing re-renders, nothing is said.

The breakdown dropdown is the sharp end. It is a controlled
`<select value={b.status}>`, and React only pushes a controlled value back into
the DOM when a render happens. On failure no state changes, so no render happens,
so the browser keeps displaying the option the operator just picked. The control
therefore asserts an outcome the code never established.

The same file already had the honest pattern in eight other places
(`catch (e) { setErr(apiErrText(e)); }`); these six were the ones that did not.

`frontend/scripts/check-silent-mutations.mjs` could not see any of them: its
whole universe is `useMutation(` call sites (303 of them), and these are raw
`api.post` / `api.patch` / `api.del` calls. There are 943 such raw write calls
across 141 files in `frontend/src`.

**Fix.** All six now set an error the card renders, using the file's own
`apiErrText`. `BreakdownSection` gained a section-level error line (a refused
status change has no form to sit under); `WorkOrderCard` and `ComponentCard`
gained their own `err` state and render it inside the card.

Pinned by `frontend/src/pages/fleetHealthWriteFailures.test.tsx`, four tests.
**Proved RED on the unfixed tree first** — all four failed with
`Unable to find an element with the text: /not allowed from the current state/i`
and `/could not save|not allowed/i`, then passed after the fix.

**Ref.** fix/ui-claims-it-did-not-verify, 2026-08-21.
