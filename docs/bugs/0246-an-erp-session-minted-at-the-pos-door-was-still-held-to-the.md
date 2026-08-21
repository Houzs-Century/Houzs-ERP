## An ERP session minted at the POS door was still held to the POS's rules [high]

<!-- area: Sales orders + pricing -->

**Symptom.** A salesperson signed in at the POS PIN door, tapped the tablet's
"open in Houzs" button, landed on the ERP Sales Order screen, and could not
change a delivery-fee line from 250 to 125:

    422 so_total_below_original
    "Changes cannot reduce the bill below the original sales order total."

Owner, on being shown it: 「为什么我们要跟着 POS 的规矩?进了这个 ERP 就跟这个
ERP 的规矩。在我们 ERP 里编辑,金额就必须能改。」

**Root cause (traced).** `POST /api/pos/exchange-web-session` — the SSO handoff
that mints the token behind `erp.houzscentury.com/#sso=<token>` — carried the
caller's `origin='pos'` onto the session it minted (added 2026-08-14, "an
exchange must never widen the session it is exchanged from"). `origin` rides the
session row for the full 7-day life of the token, and every refusal in the SO
pricing envelope hangs off exactly one expression, `isPosTabletCaller(c)` =
`c.get('sessionOrigin') === SESSION_ORIGIN_POS`. So the ERP web app was being
judged by the POS's rules on every screen the salesperson reached: five
`so_total_below_original` money floors, four `pricing_drift` 400s, and
`trustOperatorSelling` withheld on all three recompute paths.

**Fix.** The exchange mints an ORIGIN-LESS session. It is an ERP session and it
follows the ERP's rules. `/pin-login` is still the only writer of
`SESSION_ORIGIN_POS`, so the tablet's own token is unchanged and the real POS
surface keeps every restriction it has today. This is a deliberate POLICY
reversal of the 2026-08-14 tightening, not a correction of it: that change was
right that a tablet could shed the marker in one request, and the owner has ruled
that shedding it at the ERP door is exactly what should happen. What is gone: a
tampered POS can now escape the price envelope by exchanging for a web token, so
the envelope binds the POS APP and not the device or the person. What remains is
the per-line audit trail (actorId / actorName on every SO line mutation). The
narrower long-term hinge, if the owner ever wants one, is the existing
`scm.so.price_override` permission key granted via Team > Positions.

**Ref.** this PR, 2026-08-16. `backend/src/routes/pos.ts`,
`backend/tests/posExchangeSessionOrigin.test.ts`.
