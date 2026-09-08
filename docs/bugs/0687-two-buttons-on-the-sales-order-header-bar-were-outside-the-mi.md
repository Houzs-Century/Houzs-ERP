## Two buttons on the Sales Order header bar were outside the migrated read-only gate, so a migrated order still offered Cancel and Collect payment [medium]

**Symptom.** On the deployed build, a migrated sales order
(`HC-SO-013518`) rendered the "View only — carried over from AutoCount" banner
and a correctly greyed **Submit SO Amendment** — and, on the same bar, a live
**Cancel SO** and a live **Collect payment**:

```
label: "Collect payment"     disabled: false
label: "Cancel SO"           disabled: false
label: "Submit SO Amendment" disabled: true
```

Both are writes (`PATCH /:docNo/status` and, through the `?payments=1`
deep-link, `POST /:docNo/payments`). The server refuses both with
`409 so_migrated_readonly`, so nothing could be corrupted. What the salesperson
got was a toast *after* clicking, on a control that should never have been
offered — the exact experience the migrated gate was built to prevent.

**Root cause (traced, not guessed).** The gate landed on `editDisabled` and on
the payments *card* in `SalesOrderDetailV2.tsx`. The header bar sits above both
and computes nothing from either: `Collect payment` renders on a bare status
test (`!["cancelled","draft"].includes(status)`) and `Cancel SO` on
`status !== "cancelled"`. Neither ever consulted `migratedLocked`.

The tests missed it for the same reason the author did. The structural
assertions added with the gate check that each surface *imports and uses* the
shared predicate — which `SalesOrderDetailV2.tsx` does, four lines away. "The
file consults the gate" is not "every write on the file is behind it", and only
the second one is the property that matters.

**Fix.** `Collect payment` is HIDDEN: it is the door to keying money against a
balance the ERP knows is wrong (AutoCount payments since 2026-08-28 have not
reached us), which is the whole reason the document is shut, so there is nothing
useful behind it. `Cancel SO` is DISABLED WITH THE REASON rather than hidden: it
is the most destructive control on the bar, and someone looking for it has to
find out *why* it cannot be used instead of wondering where it went. Its
tooltip is the same server-authored sentence the banner carries.

Pinned in `frontend/src/vendor/scm/lib/so-detail-gates.migrated.test.ts` with a
note saying the header bar is a different place from the gates the other
assertions cover.

**How it was found, which is the transferable part.** Not by a test and not by
review — by opening the deployed page and reading `disabled` off every button in
the bar. The account available bypasses the lock (`*` / `scm.admin`), so the
tab's own `fetch` was shimmed to return `migrated_readonly: true`; nothing was
written anywhere. A gate whose UI half is only ever asserted in a unit test is a
gate nobody has looked at.

**Ref** — fix/so-migrated-readonly-cancel-collect, 2026-09-08. Follows #3151.
