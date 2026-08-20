## A salesperson could not set an SO line to RM 0 — the save succeeded and silently reverted [medium]

**Symptom.** In Houzs ERP, a salesperson edited a line from RM 2,990 to 0 and
pressed Save. No error. On reload the line read RM 2,990 again. Reducing to a
NON-zero figure (2,990 → 2,000) worked and persisted; only exactly 0 came back.

A silent revert is worse than a refusal: nothing told the operator the order
still carried the old price, and the customer-facing figure was wrong until
someone happened to reload.

**Root cause (traced, not guessed).** `0` carries two meanings on this wire, and
the engine could only read one of them. `mfg-pricing-recompute`:

```
if (trustOperatorSelling && (manualUnitSelling > 0 || trustOperatorSelling === 'including-zero')) {
  unitToPersistSen = manualUnitSelling;
}
```

An ERP session is origin-less, so `trustOperatorSelling` was already `true` —
which is why 2,000 persisted. The `manualUnitSelling > 0` arm is what dropped the
zero, and it is deliberate everywhere else: a client `unitPriceCenti` of 0 means
"I could not resolve a price, you decide", and the drift gate carves it out on
exactly that reading (`clientCenti === 0 && serverSen > 0` → no drift). So the
line fell through to the catalogue fill, which is the correct answer for every
caller that cannot state its intent.

Three separate notes defended that reading — the `TrustSelling` docblock ("Do
NOT reach for it on a line the operator is authoring now"), the amendment path
("plain `true`, never 'including-zero', on a native order"), and the add-line
note. None of them is wrong. The gap they leave is that no caller had a way to
say "this zero is deliberate", so the ambiguous reading was the only safe one.

**Fix.** Give the one caller that knows a way to say so. The ERP line editor now
sends `zeroPriceIntended: true` alongside a 0, and only then does the route
select a NEW trust mode, `'operator-zero'`, which believes it.

Deliberately a distinct mode rather than reuse of `'including-zero'`:
`isMigratedTrust` also suppresses selling surcharges, because a MIGRATED
document must never be re-priced (10,856 of 13,909 migrated lines are priced 0).
An operator-authored zero is not migrated history and must keep pricing its
director-authored surcharges, so it must not read as migrated. Owner
requirement, relayed 2026-08-18.

**Residual risk, and what holds it.** A salesperson can now zero a line in the
ERP, and nothing refuses it — that is the requested behaviour, not an oversight.
What remains is visibility: the edit lands in `mfg_so_audit_log` with from → to,
so a line taken to RM 0 is answerable after the fact.

The narrow part is deliberate and is what the tests pin: the mode needs an
explicit `=== true` claim, at a zero price, off a POS session. A 0 arriving
without the claim — every other caller in the system, including the POS — still
means "not provided" and still takes the catalogue fill. If that ever stops
being true the wiring test fails, because the risk here is not a wrong verdict
but the mode becoming reachable without the claim, which no test over the engine
alone would notice.
