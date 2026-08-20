## Every /:id/linked endpoint resolved another company's documents [high]

**Symptom** - the Smart Buttons fan-out (`GET /:id/linked`) returned the linked
GRN / invoice / return / receive numbers for ANY document id, regardless of which
company the caller was in. Seven endpoints, one shape.

**Root cause (traced, not guessed)** - on every one of the seven SCM routers that
expose `/:id/linked`, the list and detail reads are company-scoped
(`scopeToCompany`) and the writes use the strict
`requireActiveCompanyId` + `scopeToCompanyId` pair — but the `/linked` read was
written as a bare `.eq('id', id)` with no scope at all. Two of the module guides
(`purchase-return.md` §6, `purchase-consignment-order.md` §7) claimed "every read
is company-scoped", which is how it survived review: the doc asserted a guard the
code never had.

The guide-verification sweep reported TWO leaky endpoints because two agents each
saw only their own router. Grepping `get('/:id/linked'` across
`backend/src/scm/routes` found **seven**: grns, mfg-purchase-orders,
purchase-consignment-orders, purchase-consignment-receives,
purchase-consignment-returns, purchase-invoices, purchase-returns.

**Fix** - all seven scoped. Five read an anchor row by id and now wrap it in
`scopeToCompany`; two (mfg-purchase-orders, purchase-consignment-orders) only fan
out by parent id, so they gained an explicit ownership check before the fan-out,
answering 404 — an unreachable row must not confirm its own existence.
Verified: backend typecheck clean; companyScopeHardening + assrCompanyScope pass
(24 tests); all seven re-grepped and each now carries `scopeToCompany` inside its
handler.

**Exposure** - low but real: ids are UUIDs, so this needed a leaked or guessed id
rather than enumeration. It returned document NUMBERS and ids, not amounts.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---
