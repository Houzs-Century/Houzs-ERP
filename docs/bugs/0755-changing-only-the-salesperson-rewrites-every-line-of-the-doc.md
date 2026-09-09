## Changing only the salesperson rewrites every line of the document in AutoCount [high]
<!-- area: AutoCount sync + write-back -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-09, looking at the AutoCount Sync page: 「其实是在
daily 我们的 sales order，可是我不知道为什么他 daily 找到了问题，没有直接写入更改
那个数据，而是更改了数据之后把这个数据意外 sync 回去 AutoCount … 这个要尽快取消，
不要让它 sync 过去 … 我担心有些东西 sync 错了就完蛋了。」

Measured on production 2026-09-09 08:09–09:31 UTC (read-only DSN):

- A **salesperson handover** was carried out through the ERP — 362 sales orders,
  `salespersonId` and `agent` moved from CHANG SHI TING to Shawn, audit note
  "Salesperson handover", `scm.mfg_so_audit_log` action `UPDATE_DETAILS`,
  source `web`. Nothing else was touched: across all 379 of the day's audit rows
  the only other fields to appear were 11 delivery dates, 10 processing dates and
  a handful of addresses. **No quantity, no price, no item code, no amount.**
- Each of those saves queued a **whole-document** `edit` into
  `scm.autocount_outbox`. By 09:31 the drain had sent 379 of them across 320
  documents at 20 per five-minute sweep.
- The payload is not a salesperson change. It is
  `{DocNo, DocType, Header, Lines[], Rebuild?}` where `Header` carries
  DebtorName, four delivery-address lines, four invoice-address lines, Phone1,
  Ref, SalesLocation and the UDF block (VENUE / BRANDING / PAYEMENT), and every
  line carries `ItemCode, Qty, UnitPrice, Description, Desc2, Location` against
  its `DtlKey`.

So a one-field edit republished ~320 documents into a **live licensed account
book**, in the middle of a cutover whose entire purpose is to make the ERP agree
with that book. The direction is backwards: the ERP's sales orders were pulled
FROM AutoCount and are still being corrected by hand against it.

**Blast radius, and why it is small.** The write only changes the book where the
two sides already disagreed. The read-only tally run immediately before the
handover (`so-tally-verdict.yml`, run `34319492191`, 06:32 UTC) put that at
**15 of 2,889 sales orders differing, 25 more not comparable** — so at most those
40 documents could have taken an ERP value, and 2,849 were byte-identical
republishes. No row carried `Rebuild`, which matters: a rebuild destroys and
reissues every `DtlKey` (`autocount-requeue.ts:623`) and would have broken the
book's own transfer links. Of today's 379 sent edits, **zero** were rebuilds.

**Root cause (traced).** `enqueueAcEdit`
(`backend/src/scm/lib/autocount-outbox.ts:1301`) is wired to the sales-order save
and composes `composed.edit()` — the entire document — with `dedupeKey: null`,
deliberately, so that "two successive saves are two different intents and must
both be applied". That is the right rule for a document whose LINES changed. It
is the wrong rule for a save that changed only a header field the composer does
not even read differently: the queue row is built from the current state of the
whole document rather than from the fields the save actually touched, so the
smallest possible edit and a full re-pricing produce the same payload.

`scm.mfg_so_audit_log.field_changes` already records exactly which fields moved,
on the same save, in the same transaction — the information needed to narrow the
payload is captured and then not used.

**Not a defect, and deliberately left alone.** The `*/5` drain, the claim lease,
the four refusal classes and the write-back switch all behaved exactly as
documented. The switch is not the fix: `scm.autocount_writeback` takes
'off' / 'all' / a list of COMPANY ids, so turning it off for company 1 would also
have stopped the genuine documents queued behind the flood.

**Fix (proposed, not yet written).** Compose an `edit` from the fields the save
changed. The narrow case — header-only changes such as `salespersonId`/`agent` —
should send a header-only payload with no `Lines` block at all, which is what the
book needs to record a handover and is the one thing the current payload buries.
Falling back to the whole document whenever the changed set cannot be determined
keeps today's behaviour as the safe default.

**Stop-gap shipped with this ticket.**
`backend/scripts/cancel-stale-writeback-edits.mjs` +
`.github/workflows/cancel-stale-writeback-edits.yml` cancel queued edits whose
document was not modified in the minutes before the row was created — a bulk
re-queue rather than somebody's save — by moving them to `skipped`, which the
drain and the claim both refuse. It leaves genuine saves and every non-`edit`
operation alone, so real orders keep flowing while the flood is stopped. It is
idempotent and is meant to be re-run if a flood starts again.
