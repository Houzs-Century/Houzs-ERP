## A 2990 sales invoice could not be booked — revenue posted to one SALES role (500-0000, inactive for 2990) instead of each product group's own sales account [high]

<!-- area: Accounting + GL -->

**Symptom.** Found on the way to the deposit-invoice design's next step (the
final invoice at delivery, owner 2026-09-12). Every sales invoice posted
`Dr AR / Cr roles.SALES` for the whole total. For 2990, `roles.SALES` is
500-0000 RENTAL REVENUE and it is INACTIVE in the accountant's chart — the
engine would refuse the entry, so the first 2990 sales invoice ever raised
would have carried no revenue at all. For HOUZS the same rule booked every
sale onto RENTAL REVENUE while the chart keeps SALES OF SOFA / BEDDING /
DINING / SERVICE INCOME as separate leaves, and the Item Groups page already
binds each product group to its sales account — a binding nothing read.

**Root cause (traced).** `siLines` (acc/rules.ts) was the two-line template
from before the item-group registry existed. The purchase side moved to one
debit per product group on 2026-09-05 (GL redesign item 2); the sales side
never did.

**Fix.** One home for the split both sides share:
`backend/src/acc/item-group-split.ts` — case-fold the group code, refuse a
line with no group and a group with no binding by name (挡下来提醒我去绑),
FX once per group, the remainder on the largest group so the entry sums to
the header total. `postPiAccounting` reads its debits from it (behaviour
unchanged, pinned by `tests/piPeriodicPosting.test.ts`); `postSiRevenue`
(`lib/post-si-revenue.ts`) now reads the invoice's lines, splits them on
`acc_item_group_accounts.sales_account`, and posts Dr AR (party the
customer) / Cr one line per group (`siLines`). An invoice whose group is not
bound, or whose line has no group, stays unposted under a named status
(`group_unbound` / `line_ungrouped` / `no_lines`) — the create, confirm and
resync paths already log and retry it, and binding the group on Accounting →
Item Groups is the fix.

Pinned by `backend/src/scm/lib/post-si-revenue.test.ts` (the credit lands on
the group's account; two groups split, case-folded, the remainder on the
largest; the three refusals post nothing) and `backend/src/acc/engine.test.ts`
(the rule's lines).

**Ref.** acc/si-revenue-groups, 2026-09-12.
