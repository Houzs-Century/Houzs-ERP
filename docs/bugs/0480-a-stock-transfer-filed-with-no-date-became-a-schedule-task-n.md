## A stock transfer filed with no date became a schedule task nobody could see [high]

<!-- area: Projects + PMS + fair report -->

**白话.** 在项目里加一笔出货/退货记录时，日期栏可以留空 —— 系统照单全收，但它自动
生成的那条排程任务就变成「没有日期」，在任务列表的日期栏、甘特图、所有到期统计里
全部看不见，而且**永远**不会被补上。更阴的一种：日期挑了、时间没填 —— 画面上那个
日期还好端端地显示着，送出去的却是空的。现在留空一律当**今天**（不挡人），而且
日期时间只填一半的时候，栏位会自己标红说「还没填完」。

**Symptom (the reported one, and why it was wrong).** The audit reported this as
a MOBILE defect: `MobilePMS.tsx` posts to `POST /api/projects/:id/stock-transfers`
with `direction` hardcoded to `"out"` and no `transferred_at` / `notes`, so a
storekeeper filing a stock-out from the phone would create a dateless task.

**That story does not hold, and checking it is what found the real one.** The
mobile function containing that POST — `uploadTransfer` — was UNREACHABLE DEAD
CODE. `grep -rn "uploadTransfer" frontend/src/` returned exactly one line: its own
definition. Its only call site was deleted on 2026-07-17 in `034e9a335`, when the
mobile Floor Plans card moved to `uploadStockOut`
(`PUT /checklist/:taskId/attachments` + auto-submit for review). The file's own
comment says so: *"The legacy project-level stock_transfers store is unused: every
stock-out record is attached to the task."* No mobile path reaches that endpoint
in either direction.

**The real defect is on DESKTOP — the surface the audit called correct.**
`AddStockTransferForm` (`Projects.tsx`) is the only live caller, and it reaches
the dateless state two ways:

1. `transferredAt` initialises to `""`, nothing requires it, and Save is
   `disabled={submitting}` only. Blank date → `transferred_at: undefined`.
2. **The silent one.** `joinDateTimeLocal` (`vendor/scm/components/DateTimeField.tsx`)
   returns the empty string unless BOTH halves are present. An operator who picks the
   date and leaves the TIME blank emits `''` — while the date they picked **stays
   on screen**, because the two halves live in the component's local state. The
   screen and the payload disagree and nothing marks the difference.

**Root cause (traced).** `createStockTransfer` (`services/projects.ts`) stored
`input.transferred_at ?? null`, then `syncStockTransferTask` mirrored the transfer
into `project_checklist` — and **the mirror row's title and its `due_date` both
come from that one field**. A NULL produced `due_date NULL` and the bare title
`"Stock OUT"`. Permanently: `redateChecklistFromOffsets` deliberately skips
`notes LIKE 'auto:%'` rows, because a transfer's date is supposed to follow the
transfer rather than the project schedule. Nothing else ever revisits it.

**Fix.** A missing `transferred_at` now **defaults to today** rather than being
refused — default-never-refuse, the owner's standing rule for this system, and the
same shape the PO expected-date and the journal entry-date already use. `todayMyt()`
and NOT `toISOString()`: Workers run in UTC, so before 08:00 MYT a raw UTC slice
files the transfer under YESTERDAY — the whole morning shift, every day. Date-only
on purpose: we know the day, we do not know the time, and a silently invented 00:00
is a worse answer than an honest date. Applied at CREATION only, so a legacy NULL
row still renders honestly instead of having a date invented for its history.

**`joinDateTimeLocal` was deliberately NOT changed.** Emitting `''` on a half-filled
control is native `datetime-local` parity; the component's header argues for it
explicitly, refusing to invent 00:00 inside what was scoped as a display fix, and
three assertions pin it (`DateTimeField.test.tsx`). Changing it would also have
altered the payload of all six other call sites. What was missing was not a
different value but a way to SAY the field is incomplete: the EMPTY half now
carries `aria-invalid` + a red border + a hint, so the disagreement between screen
and payload is visible without inventing anything. `DateField` also gained
`aria-invalid` for its existing `invalid` prop, which until now painted a red
border that no screen reader and no test could see.

**Also deleted:** the dead `uploadTransfer`.

**Test.** `backend/tests/stockTransferDate.test.ts` (4) and the
`DateTimeField half-filled disclosure` block (5). Proved RED on the unfixed tree:
`expected null not to be null` for both `transferred_at` and the mirror row's
`due_date`, `expected 'Stock OUT' not to be 'Stock OUT'` for the title, and
`expected null to be 'true'` ×3 for the disclosure. Each set ships with a control
that was GREEN before and stays green — a supplied date is kept byte-for-byte and
never replaced by today; a complete field and a fully empty field are not flagged.

**Left for the owner, NOT run.** Rows created before this fix still carry
`due_date NULL` and the bare title. Whether to repair them is a data decision, and
the count was not measured — no production query was run from this branch. The
census is:

```sql
SELECT count(*) FROM project_checklist
 WHERE notes LIKE 'auto:stock_transfer=%' AND due_date IS NULL;
```

A repair would have to invent a date for each one (the transfer row's own
`transferred_at` is equally NULL, which is what produced the task), so the honest
options are: leave them, or set them from the row's `created_at`. That is the
owner's call, not a defect fix.

**Ref.** `fix/pms-transfer-date-and-swallowed-error`, 2026-08-21.
