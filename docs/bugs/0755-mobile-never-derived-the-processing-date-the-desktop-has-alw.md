## Mobile never derived the Processing Date the desktop has always derived [medium]

**Symptom.** Salesperson Cheah Huan, on the phone: 「那个日期 proceed date 之前
是有 auto detect 的，现在的需要自己填」. She was typing a date the desktop fills
in for her.

**Root cause (traced).** Desktop's `SalesOrderNew.tsx` derives it —
`Processing = max(today, Delivery − 6 weeks)` — through
`frontend/src/lib/processingDate.ts` (`deriveProcessingDate`,
`PROCESSING_LEAD_DAYS = 42`), which already has its own tests.

`MobileNewSO.tsx` never called it. Its `procDate` starts as
`scanPrefill?.slipDate ?? ""`, and no call site supplies `scanPrefill` — the
file's own comment marks that path LATENT — so on mobile the field is always
blank and always hand-typed.

Nothing was removed; the affordance was only ever built on one surface. That is
the recurring class CLAUDE.md names: *desktop and mobile are one product*, and a
rule implemented on one surface only.

The shared module's header had even predicted this fix in writing: *"mobile does
not derive a Processing Date at all … if that ever becomes a shared affordance,
this is the module both surfaces import rather than the second hand-written copy
of '42 days, but not the past'."*

**Fix.** Mobile's Delivery Date picker now calls the SAME
`deriveProcessingDate` on change. Two deliberate limits:

- it fills a **blank** Processing Date only — a date already on the order, or one
  the rep just typed, is theirs and is not overwritten;
- **clearing** Delivery leaves Processing alone. The both-or-neither rule is a
  server-side save gate (`processing_delivery_must_pair`) that names the problem,
  and the field has its own Clear control.

No second copy of the rule: the constant and the arithmetic stay in
`frontend/src/lib/processingDate.ts`, which both surfaces now import.

**UNVERIFIED IN A BROWSER.** Typecheck and unit tests only. CLAUDE.md asks for a
browser check on a UI change and this one has not had it; the real proof is the
next order Cheah Huan writes on the phone.

**Ref.** `fix/mobile-proceed-date-derive`, 2026-09-09.
