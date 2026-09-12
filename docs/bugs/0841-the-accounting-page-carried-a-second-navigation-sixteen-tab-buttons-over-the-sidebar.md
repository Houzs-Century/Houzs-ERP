## The Accounting page carried a second navigation — sixteen tab buttons over the sidebar's three groups [low]

<!-- area: Frontend + mobile -->

**Symptom.** The Accounting page opened on a strip of sixteen tab buttons
(Chart of Accounts … Performance P&L) while the Finance sidebar already
deep-links every one of them under Books / Reports / Setup (docs/bugs/0824).
Two ways to the same sixteen places, one of them unsorted: 上面这边还有这些选
项，让人有点混乱. Owner 2026-09-12: 只靠侧栏就好，不然太乱了.

**Root cause.** The strip predates the sidebar groups; when the sidebar took
the deep links (2026-09-12, 0824) the strip stayed.

**Fix.** `frontend/src/pages/scm-v2/Accounting.tsx` drops the strip and its
button component; the sidebar is the one way between tabs, and the page
header names the tab it shows — "Accounting · P&L" — from
`ACCOUNTING_TAB_TITLES` in `frontend/src/pages/scm-v2/accounting-tabs.ts`,
which is now the one home of the tab set (`ACCOUNTING_TABS` is its keys). The
URL still names the tab, a sidebar click while the page is open still
follows, an unknown name still falls back to the journal.

Pinned by `frontend/src/pages/scm-v2/accounting-tabs.test.ts` (every tab has
a title; the URL round-trip) and `frontend/src/components/sidebarFinanceGroups.test.ts`
(every tab is deep-linked from the sidebar).

**Ref.** acc/accounting-no-tab-strip, 2026-09-12.
