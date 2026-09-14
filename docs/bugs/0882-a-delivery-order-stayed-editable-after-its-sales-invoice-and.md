## A delivery order stayed editable after its Sales Invoice, and the phone could not edit a delivery order at all [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Two things, one session (2026-09-14).
The owner: 「我的 Sales Invoice 开了，正常上游的单就锁了」 — once the invoice is out,
the delivery order it came from should be locked. It was not: staff could still
change the customer's phone, address, city / state / postcode, email, emergency
contact, the customer's delivery date and the notes on a delivery order that
had already been invoiced, so the delivery order and its invoice could say two
different things about the same customer.
And on the phone a delivery order opened read-only — the owner's 2026-09-12
ruling is full desktop parity with the same permissions.

**Root cause (traced).** Not a slip — a rule that was deliberately narrow and
has now been overruled. `PATCH /delivery-orders-mfg/:id` checked
`changedLockedCols(DO_IDENTITY_LOCK_COLS, …)`, and that set was
`debtor_code, debtor_name, currency, sales_location, branding` only
(`backend/src/scm/shared/document-policy.ts`, owner 2026-08-20 "越松越好"). Every
other header column saved with a live invoice. The rule also lived only on the
server: the desktop edit form (`DeliveryOrderNewV2.tsx ?edit=`) disabled
nothing, so an operator learned about a lock only from a refusal after typing.
The phone had no header edit screen at all — `MobileModuleDetail` offered Edit
only to modules with a generic form `updatePath`, and the delivery order has none.

**Fix.** One rule, one place, three readers.
`backend/src/scm/shared/do-header-lock.ts` (byte-identical copy
`frontend/src/vendor/shared/do-header-lock.ts`, refereed by
`do-header-lock.canonical.test.ts`) lists the locked columns and the open ones.
The server's PATCH refuses on it (409 `do_identity_locked`, the same code); the
desktop edit form and the new phone screen `MobileDoHeaderEdit.tsx` disable
exactly those fields and drop them from the body. Both screens seed and build
the header through `frontend/src/vendor/scm/lib/do-header-form.ts` and save
through the same `useUpdateMfgDeliveryOrderHeader`. Stays open after an invoice:
driver, vehicle, expected delivery date, the delivery-execution times, and the
salesperson (kept open by the separate 2026-08-17 hand-over ruling — flagged to
the owner). `tests/doHeaderLockPartition.test.ts` fails a PATCH column that is
not classified either way. The Consignment Note, which used to share the DO's
set, keeps the old minimal set — the ruling was about the DO.

Proved RED on the unfixed tree: `doHeaderFieldLock.test.ts` 11 failed of 22 (every
newly locked field saved with 200); `document-policy.test.ts` 1 failed of 5;
`DeliveryOrderNewV2.headerLock.test.tsx` 1 failed of 2 (no notice, fields
enabled); `MobileDoHeaderEdit.test.tsx` could not load — the screen did not exist.

**Ref.** feat/mobile-do-edit, 2026-09-14.
