## Finance sidebar: fifteen flat entries and thirteen Accounting tabs — the reports, the books and the setup were scattered across two lists [low]

<!-- area: Accounting + GL -->

**Symptom.** The Finance group of the sidebar (`frontend/src/components/Sidebar.tsx`)
had grown to fifteen flat entries in the order they were built — Accounting,
Daily Bank, Merchant Recon, Official Receipts, Bank Recon, Recon Setup, Chart
of Accounts, Other Debtors, AP Invoices, Receipts, Payment Vouchers,
Outstanding, Not Yet Billed, Currencies, Sales Report — while the Accounting
page hid thirteen more screens behind its tab strip (P&L, Balance Sheet,
Receipts & Payments, AR and AP aging, the Corrections report, the journal, the
ledger, the trial balance, month-end, self-check, item groups). Owner
(2026-09-12): 「finance 的 function 分到很散，我希望我要 maintenance 的东西一个子
side bar，report 一个 side bar … 关于 finance 这里的 report 全部集中在一个
side bar，包括那个 finance 改 sales order 的报告」.

**Root cause (traced).** Each entry was appended where its feature landed;
nothing grouped them by the job, and the Accounting page's tabs were state
only (`useState('je')`), so nothing outside the page could name one.

**Fix.** The Finance group's children are six groups in the order the money
moves — Money in (Official Receipts, Receipts, Other Debtors, Outstanding, Not
Yet Billed), Money out (Payment Vouchers, AP Invoices), Bank & cards (Daily
Bank, Merchant Recon, Bank Recon), Books (Journal Entries, General Ledger,
Trial Balance, Month-end, Self-check), Reports (P&L, Balance Sheet, Receipts
& Payments, AR Aging, AP Aging, Corrections, Sales Report), Setup (Chart of
Accounts, Item Groups, Recon Setup, Currencies). Every existing entry is the
same entry with the same gates; a group carries no gate of its own (shown
when any entry is, hidden when none are — `makeNavFilter` already recurses,
and the mobile menu already renders a second level). The Accounting page's
tabs are reached by deep link, `/scm/accounting?tab=…`: `accounting-tabs.ts`
names the set, the page opens on the tab the URL names, follows a sidebar
click made while it is open, and writes the tab it shows back to the URL so
the sidebar marks it (`tabIsActive` already compares query strings). The
plain "Accounting" entry goes, its every tab being one click away.

Pinned by `frontend/src/components/sidebarFinanceGroups.test.ts` (six groups
in the owner's order; every destination the flat list had is still there;
every deep link names a tab the page knows; no destination twice; the
Corrections report sits with the reports) and
`frontend/src/pages/scm-v2/accounting-tabs.test.ts`. RED on the unfixed tree
(the flat list), then GREEN.

**Ref.** ui/finance-sidebar-groups, 2026-09-12.
