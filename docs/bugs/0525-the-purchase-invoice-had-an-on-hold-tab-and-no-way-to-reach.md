## The purchase invoice had an On Hold tab and no way to reach it [medium]

**Symptom.** The owner, 2026-08-23: 「我 put onhold 怎么没反应呢」. On the Purchase
Invoice list there is nothing to press — the right-click menu has no hold entry
at all — while the list header carries an **On Hold** tab, and the server has
`PATCH /purchase-invoices/:id/hold` mounted and working.

**Root cause (traced).** `purchaseInvoiceRowMenu` in
`frontend/src/pages/scm-v2/row-menus.ts` carried this line where the entry
belongs:

```
// Hold follows: ON_HOLD is being converted from a status into a flag.
```

That was TRUE when the menu was written: the five bare lists got their menus and
the hold-as-a-flag change were built the same day, in parallel, and the menu was
deliberately told to leave hold out so the two would not collide. **Nobody came
back.**

Mig 0324 then landed the flag, `document-hold-routes.ts` mounted the route for
all five documents, and the four lists that already HAD menus were wired. The
Purchase Invoice's menu did not exist yet when that change ran, so it was not
among them — and its On Hold tab, added by mig 0320 the day before, kept
rendering.

**This is the exact fault the flag change was written to remove**, on the one
document it could not see. Its own bug entry says it: migs 0318/0319/0320 gave
the PO, GRN and PI the WORD On Hold and *"nothing in frontend/src ever sent that
status, so the three screens rendered a state the product could not produce"*.
Two of the three were fixed. The third grew a menu afterwards and inherited the
gap.

**Fix.** `setHold` is a REQUIRED parameter on the factory, so the compiler names
every call site rather than leaving one silently unwired — which is CLAUDE.md's
optional-param-noop rule, and it worked: adding it failed the typecheck on the
one caller that had not been updated.

Keyed by `id`, because `PATCH /purchase-invoices/:id/hold` is; only the Sales
Order's route is keyed by document number.

Pinned by `frontend/src/pages/scm-v2/row-menus-remaining-lists.test.ts` — five
cases, **RED on the unfixed tree** where neither entry existed. Four existing
exact-match assertions were updated rather than loosened: the menu genuinely
changed, and an assertion that lists the whole menu is the one that notices.

**Held after PAID and after CANCELLED is deliberate**, and the test says so: a
hold is a marker, not a step, and `document-hold-route.ts` explicitly does not
gate on status.

**Ref.** fix/the-purchase-invoice-can-actually-be-held, 2026-08-23.
