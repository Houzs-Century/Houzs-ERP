## A salesperson could not lower or cancel a line they had just overcharged for [medium]

**Symptom.** On the POS tablet, any edit that reduced a line was refused:

    422 so_total_below_original
    "Changes cannot reduce the bill below the original sales order total."

It covered five verbs — PATCH a line, DELETE a line, the free-item DELETE
branch, a TBC edit, and a sofa swap — so a salesperson who keyed a wrong qty or
a dearer product could add, but never take away. The correction had to go to the
office, on an order the salesperson was standing in front of the customer with.

**Root cause.** Not a defect: a deliberate floor (Loo 2026-06-11), guarding
against a salesperson quietly cheapening a confirmed order after the customer
signed. It bound only sessions carrying `origin='pos'` — office and desktop
callers were always free to discount downward.

Two things made it read as a bug rather than a policy:

- **it was one-sided.** The same person doing the same correction was refused at
  the tablet and allowed in the ERP web app — a distinction of DOOR, not of
  intent, and invisible to whoever was holding the tablet.
- **the ERP half was fixed and this half was not.** On 2026-08-14 the SSO
  handoff started carrying `origin='pos'` onto ERP sessions, so the floor
  followed a salesperson into the ERP too. The owner hit that himself and ruled
  (see the exchange-web-session entry): 「进了这个 ERP 就跟这个 ERP 的规矩。在
  我们 ERP 里编辑,金额就必须能改。」 That reversal fixed the ERP path only. The
  tablet kept the floor for four more days.

**Fix.** The five floors are removed. Owner ruling, relayed 2026-08-18: a POS
caller may lower or cancel a line.

**What is deliberately NOT removed.** The four `pricing_drift` 400s hang off the
SAME expression (`isPosTabletCaller`) and stay. They are a different rule: they
refuse a client price that disagrees with the server's own recompute, which is
what stops a tampered POS bundle submitting a doctored total. Removing the
floors must not take those with it, and `tests/soTotalFloorRemoved.test.ts`
asserts both halves — floors absent, drift rejects present, and the hinge itself
still read so a later "unused" cleanup cannot make them unreachable.

**Residual risk, and what holds it.** Nothing now stops a salesperson reducing a
confirmed order from the tablet, which is exactly what the floor was written to
prevent. What remains is visibility, not prevention: every line edit is recorded
in `mfg_so_audit_log` with from → to, and the sofa-swap path still computes both
totals for that record even though nothing compares them any more. If this is
ever regretted, the audit log is where the evidence is — and the floor should
come back as a REPORT (orders reduced after confirmation), not as a refusal the
office has to unblock one order at a time.
