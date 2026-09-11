## No collection report — deposit collected against order value per salesman, and balance collected after delivery, could not be read anywhere [low]

<!-- area: Accounting + GL -->

**Symptom.** Finance had no way to see, for the orders opened in a period,
how much deposit each salesman had collected against the order value, which
orders sat under 50%, or — for the delivered ones — how much of the balance
had come in. Owner (2026-09-11/12): 「我需要两份报告 … collection report，例如
salesman 开了多少单，deposit 收了多少%，我要 overall 的，filter date，below 50% 的
我也需要知道」, then 「分主要看两个，应该是 deposit / sales order amount，一个是看
balance paid」.

**Root cause (traced).** The figures existed only per order — the SO screen
and the payments recorded on it — and the SO's own balance columns are not
maintained (2990's 168 orders since June show `balance_sen` equal to the
total with RM 387,978 of deposits recorded), so nothing could be summed
without reading the payments.

**Fix.** `GET /accounting/reports/collection?from&to&threshold&salesperson`
(`backend/src/scm/routes/accounting-collection.ts`) reads the orders opened
in the period by SO date (DRAFT and CANCELLED are not orders), their
payments (flagged deposit → deposit, else balance), and the staff names, and
answers per salesman: orders, order value, deposit, deposit %, the count
under the threshold (default 50%), and for the delivered orders (DELIVERED /
INVOICED / CLOSED) the balance due after deposit, balance collected, balance
% and outstanding — with totals and the orders themselves. The Collection
tab (`frontend/src/pages/scm-v2/CollectionReport.tsx`, reached from the
Reports group as `/scm/accounting?tab=collection`) shows the deposit and
balance views, opens a salesman to the orders, narrows to the orders under
the line, and exports the open view as CSV.

Pinned by `backend/tests/collectionReport.test.ts` (deposit per salesman
with two deposits counted together, the under-threshold count, cancelled /
draft / out-of-range orders absent; the balance view over the delivered
orders only; the threshold and salesperson filters; a bad range refused and
the permission gate) and `frontend/src/pages/scm-v2/CollectionReport.test.tsx`
(the two views, opening a salesman, "only below", the threshold reaching the
server, the CSV of each view). New surface, so no RED beyond the absence.

**Ref.** acc/collection-report, 2026-09-12.
