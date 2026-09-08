## Cannot be compared was counted as differ so the sales-order verdict reported 149 documents when 110 had never been compared [high]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 老板问了三次「SO 都tally了吗」。每次答案都要有人翻那份 1,300 行的对账
报告，从三个不同的表里凑出来 —— 所以 2026-09-08 同一批单，同一天，有人说「0 个不
一样」，有人说「8 个不一样」，机器自己又说「149 个不一样」。三句话都是真的，讲的
是三个不同的地方，但没有一句是答案。

最要命的是那 149 里面有 110 张，是**根本没比过**的沙发 —— 账本自己的字没写清楚
几件，只有老板画的图能定。把它们算进「不一样」，等于凭空造出 110 张没人欠的工作；
算进「一样」，等于说 110 张查过了，其实一张都没查。这次给它自己一栏，永远不并进
左右任何一边。

**Symptom.** Reconcile run `34216507949` (2026-09-08 10:38 UTC) printed three
different true answers about company 1's sales orders, in three places of one
log:

| where in the log | what it said |
| --- | --- |
| the `SUMMARY` table's `SO` row | `absent 0 · lineCnt 0 · item 0 · qty 0 · price 0 · money 0` — reads as **nothing wrong** |
| `SO VARIANT sofa compartments` | `8 DIFFER on a PROCEEDED order (+34 on orders not yet proceeded)` |
| `PER-DOCUMENT VERDICT` | `2733 match it exactly and would OPEN; 149 still differ and stay LOCKED` |

Of the 149, **110 were `sofa build not verifiable`** — documents on which the
comparison did not run at all, because the account book's own Desc2 does not
decode into pieces. They were reported under the word `differ`.

**Root cause (traced).** `backend/scripts/lib/so-verdict-derive.mjs` has one
channel, `record()`, and `summariseVerdict` derives its whole answer from
`clean === false`. `sofa build not verifiable` is a member of `LOCKING_AXES`
(correctly — a comparison that did not run must never OPEN a document), so a
document the checker REFUSED to answer about and a document that genuinely
disagrees are the same row shape, and the only counter counts them together:

```js
// lib/so-verdict-derive.mjs, before this change
return { docCount: rows.length, cleanCount: clean, differCount: rows.length - clean, ... };
```

`variant-report.mjs:161` records the refusal, with a comment saying exactly why
it must lock — and it is right. The defect is not there. It is that **nothing
downstream could tell the two apart**, and the only artifact that reached the
owner was the `differCount` subtraction above. Traced by reading the verdict
file that run wrote (`VERDICT_OUT`) rather than the log: `sofa build not
verifiable` 110 documents, `sofa compartments` 38, `a book line we do not
have` 1, `specials` 1 — 149 rows, of which 110 carry no other axis.

The second half is that no artifact answered the question at all. The document
axis (`absent`, `phantom`) lives only in the `SUMMARY` table, the variant axes
only in the variants table, the refusal causes only in the unread cross-tab, and
the per-document roll-up in a fourth block. Assembling them by hand is what
produced "0 differ" and "8 differ" on the same corpus on the same day.

**Fix.** A single artifact, and a bucket that cannot be absorbed.

| change | file |
| --- | --- |
| `UNANSWERABLE_AXES`, asserted at import to be a subset of `LOCKING_AXES` | `backend/scripts/lib/so-verdict-derive.mjs` |
| `note()` — a NON-locking channel recording the declared classes, so what the verdict excluded is named rather than trusted | same |
| `presence()` — the document axis, named per document; an absent or phantom document has no comparison row to be listed from | same |
| `bucketOf` / `tallyVerdict` / `isTallied` / `renderVerdict` — the four buckets, the owner-facing axis table, and the one place the word TALLIED is decided | `backend/scripts/lib/so-tally-verdict.mjs` (new) |
| the report: runs the reconcile, reads its verdict file, cross-checks against the reconcile's own printed numbers, REFUSES if they disagree | `backend/scripts/check-so-tally.mjs` (new) |
| `workflow_dispatch`, read-only, own concurrency group | `.github/workflows/so-tally-verdict.yml` (new) |

`clean` is **unchanged** — the migrated-sales-order guard reads that column and
an unanswerable document still LOCKS. The four buckets are a reporting layer
over it, not a new opinion about it.

The report **measures nothing**. It runs `check-ac-erp-reconcile.mjs` and
classifies the rows that run decided; a second implementation of "different" is
what `docs/bugs/0708` cost. The cross-check parses the reconcile's own printed
`SO VERDICT` and `SUMMARY SO` lines and refuses to print anything if they
disagree with the file — parsing to CHECK, never to decide.

Pinned by `backend/tests/soTallyVerdict.test.mjs` (22 cases). Proved RED on the
unfixed tree: with `UNANSWERABLE_AXES` empty, *"an unanswerable axis ALONE is
its own bucket"* and *"cannot-be-compared does NOT block TALLIED"* both fail —
the row classifies as `work` and `isTallied` answers `false`, which is the
2026-09-08 behaviour exactly.

**What it measured, first run.** Dispatch of the new workflow, 2026-09-08,
company 1: 2,883 documents — **2,709 identical, 38 differ and are work (37 on
content, 1 phantom document), 109 cannot be compared, 27 the book itself is the
gap.** The 149 the old line reported is now 38 + 109 + 2 double-counted
documents that carry a real difference AND an unreadable sofa.

**Ref.** `feat/so-tally-verdict`, 2026-09-08. Measured against reconcile run
`34216507949` and the first dispatch of `so-tally-verdict.yml`.
