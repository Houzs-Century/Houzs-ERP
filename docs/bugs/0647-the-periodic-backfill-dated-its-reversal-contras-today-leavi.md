## The periodic backfill dated its reversal contras today, leaving the invoice month's stock and payables over-stated [low]

<!-- area: Accounting + GL -->

**Symptom.** After the owner ran the item-3 backfill on 2990 (2026-09-06),
the 19 re-shaped invoices carried their NEW periodic entries on the invoice
dates (June–September) as designed, but the 19 contras that cancel the old
Dr 330 / Cr AP entries were all dated 2026-09-06. A balance sheet as at
31 August therefore still showed the old entries: 330-0000 STOCK and the AP
controls each 56,914.60 too high, cancelled only in September. The owner,
looking at the JE list: 这个全部都放今天的日期?照理应该根据 PI 的日期.

**Root cause (traced).** `reversePiAccounting` (accounting.ts) is the
CANCEL path's helper and hard-codes `entryDate: todayMyt()` — right for a
void, which happens when it happens. The backfill (accounting-pi-backfill.ts)
reused it for the reshape without a date, so every contra took the run day.
Confirmed on production: `SELECT contra.entry_date, orig.entry_date FROM
scm.journal_entries contra JOIN scm.journal_entries orig ON
orig.reversed_by_je = contra.id WHERE contra.source_type = 'PI_REVERSAL'`
→ 19 rows, every contra 2026-09-06, originals 2026-07-18 … 2026-09-04.

**Fix.** `reversePiAccounting` takes an optional `entryDate`; the backfill's
reshape passes the active journal's own date (classifyPiBackfill now reads
`entry_date`), so the invoice's month cancels within itself — pinned by
tests/piPeriodicBackfill.test.ts (the contra's `entry_date` equals the
original's; RED before the change). The 19 live contras are re-dated by
`backend/scripts/repair-pi-reversal-dates.mjs` (workflow
repair-pi-reversal-dates, plan/apply with CONFIRM), which selects ONLY
reshape contras — a PI_REVERSAL whose invoice also carries a fresh active
PI journal — so a genuinely cancelled invoice keeps the day it was voided.
JE numbers stay in their September series: an audit id, not a date.

**Ref.** feat/pi-reversal-dates, 2026-09-06.
