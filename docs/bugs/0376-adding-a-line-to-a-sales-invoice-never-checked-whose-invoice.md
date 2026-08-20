## Adding a line to a Sales Invoice never checked whose invoice it was [high]

**Symptom.** `POST /api/scm/sales-invoices/:id/items` — the manual "add a line"
verb — resolved the invoice header by `id` alone. Any caller could append a
charge to the OTHER company's invoice; the totals then recomputed, the AR/GL
re-posted, and the AutoCount outbox row was queued, all from a line the other
company never entered.

**Root cause (traced, not guessed).** Two things, and the second is why nobody
saw the first.

The header read was `sb.from('sales_invoices').select(...).eq('id', id)`. A uuid
primary key is globally unique, so this is not an ambiguous-key bug — it is that
another company's uuid resolves perfectly well, and nothing compared the row's
company to the caller's.

The insert then carried `company_id: activeCompanyId(c)`. **A stamp is not a
predicate** — the fifth blind spot named in `CLAUDE.md`. The statement mentioned
the company, so it read as scoped in review and to any grep; what it actually did
was write OUR company onto a line appended to THEIR invoice.

**The asymmetry that proves it was an omission.** The 2026-08-13 sweep made every
other line verb on this same resource strict:

| verb | before this PR |
| --- | --- |
| `PATCH /:id/items/:itemId` | `requireActiveCompanyId` + `scopeToCompanyId` |
| `DELETE /:id/items/:itemId` | `requireActiveCompanyId` + `scopeToCompanyId` |
| `POST /:id/items/from-do/:doId` | `scopeToCompany` on invoice AND source DO |
| **`POST /:id/items`** | **nothing** |

**Scope of what was actually checked, so the next reader does not over-trust
this.** Seven handlers were READ in full and every one of the other six is
scoped: the three line verbs above, plus `POST /:id/payments`,
`PATCH /:id/status` and `POST /:id/items/from-do/:doId`. The rest of
`sales-invoices.ts` was NOT audited statement-by-statement in this pass — a
line-window scan over it returns a long list of apparent misses that are mostly
artefacts (a multi-line `scopeToCompany(` opens on the preceding line, and an
INSERT of a brand-new invoice legitimately stamps rather than predicates).
Resolving that list is its own pass, not a claim to make here.

**Fix.** `requireActiveCompanyId` + `scopeToCompanyId` on the header read, and the
gate MOVED AHEAD of item-code validation. That ordering is not cosmetic: a caller
pointed at another company's invoice used to be told its ITEM CODE was wrong — an
answer about a document they cannot see. Same rule the price-override handler
adopted on 2026-07-22 ("AUTHZ BEFORE CONCURRENCY").

The handler was also extracted as `appendSalesInvoiceItemHandler` and mounted by
name. Its three siblings were already exported, and being an inline arrow is
precisely why this one had no company test that could fail.

**One change that is NOT a fix, said plainly.** The insert's
`activeCompanyId(c)` became `co.companyId`. Once the header read is scoped you can
only reach the insert on your own invoice, where the two are necessarily equal —
so this is consistency, not a second defect closed. Proved: reverting it alone
leaves the suite GREEN, and that is the correct result, not a gap in the test.

**Test.** `backend/tests/companyScopeSalesInvoiceMoney.test.ts`, four cases on the
existing fake-PostgREST harness: A cannot append to B, B cannot append to A (a
one-sided gate is the failure mode nobody reports), a company CAN still append to
its own, and an UNRESOLVED company gets a 409 rather than falling through. Each
negative case asserts `sales_invoice_items` is still EMPTY — a refusal that
inserted first would pass a status-only assertion. Proved red: removing
`scopeToCompanyId` fails the suite.

**Ref.** `fix/si-items-company-scoped`, 2026-08-19. Found during the cross-company
isolation audit.
