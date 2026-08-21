## Voucher delete on both exchange paths was keyed on code alone, so it could destroy the other company's voucher [high]

**Symptom.** Nobody reported this one — it was found by the 2026-08-21 permission
audit while checking whether a write's predicate really is the tenant boundary it
is assumed to be. In business terms: when a customer exchanges a product, the
promo vouchers that came off the old line are torn up. Eight of those statements
named the voucher by its CODE and did not say which company's books it was in, so
a 2990 exchange could tear up a Houzs customer's voucher, and vice versa. A
voucher is a real discount the customer is owed.

**Root cause (traced).** Migration `0188_percompany_natural_key_masters.sql`
re-keyed the table — `PRIMARY KEY (code)` became `PRIMARY KEY (company_id, code)`
— so `code` stopped being unique on its own. The client is the SERVICE-ROLE
client and mig `0061` enabled RLS with zero policies, so nothing behind the
statement re-checks anything: the predicate IS the boundary.

Read on the unfixed tree, `backend/src/scm/routes/mfg-sales-orders.ts` carried
eight `pwp_codes` statements keyed on `code` with no `company_id`:

- `:9321` and `:10127` — the DELETEs, on the non-sofa and sofa exchange paths.
  The sofa one sits **sixty-odd lines below** a RELEASE in the same function that
  does carry both halves, under a comment reading *"HAZARD 2 again: these RELEASE
  a voucher — unfiltered hands theirs back to stock."* The rule was known and
  written down at the top of the block and not applied at the bottom of it.
- `:9245`, `:9252`, `:10081`, `:5461` — the trigger/redeemed re-stamps.
- `:9336`, `:10140` — the reads that decide how many fresh vouchers to mint, so a
  wrong count there mints the wrong number of new vouchers.

`docs/modules/sales-order.md` names this HAZARD 2 and claimed *"Three paths do
this and all three are company-filtered"*. That claim was true of the claim
paths and false of the exchange paths; it is corrected in this PR.

**Fix.** All eight statements now carry `.eq('company_id', <resolved id>)`. On the
sofa path the existing `rewardCompanyId` resolve was hoisted out of the
`if (rewardCtx)` block so the whole voucher settlement — release, re-point,
re-stamp, DELETE — shares one resolved company; the non-sofa path gained the same
resolve and refuses with `company_unresolved` (409) rather than writing
half-keyed. The SO-create re-stamp skips rather than writing when the company is
unresolved.

Pinned by `backend/tests/pwpCodeCompanyKey.test.ts`, a source scan in the LIGHT
project (so it runs inside `backend-typecheck`, a required context). **Proved RED
on the unfixed tree** — it named exactly the eight sites above, including
`mfg-sales-orders.ts:9321` and `:10127` by line, and went green on the fix.

The first version of that test also reported `:9065` and `:9630`, which are
correct: it sliced the statement from the table name forward, and the scoping
helper WRAPS the builder. The slice now walks back to the start of the statement.
A checker that cannot see the guard it is looking for reports work that does not
exist.

**Left alone, deliberately.** `backend/src/scm/lib/so-cancel-vouchers.ts` keys its
voucher writes on `source_doc_no` / `redeemed_doc_no`. A parent key proves the
voucher is on that order, not that the order is in your books — it is safe here
only because SO numbering is prefix-partitioned per company, which is a
convention recorded in a different file. That is accidental safety, and it needs
the function to take a company id, which is a wider change than this one.

**Ref.** audit/permission-system, 2026-08-21.
