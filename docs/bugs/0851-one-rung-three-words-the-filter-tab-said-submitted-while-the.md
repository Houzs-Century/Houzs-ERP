## One rung, three words: the filter tab said SUBMITTED while the pill said Confirmed [medium]

**Symptom.** The step where a document stops being a draft and becomes committed
read as three different words on screen, depending on where you looked:

- Purchase Orders list: the filter tab says **SUBMITTED**, the status pill on the
  same rows says **Confirmed**.
- Goods Received list: the tab says **CONFIRMED**.
- Sales Invoices: the invoice is **SENT** in the data and **Confirmed** on the pill.

The owner, 2026-09-12: 「你的 confirm 状态，你应该要把全部都换成一样…PI、SI、GR、
PO、SO 都要改成 submitted」.

**Root cause (traced).** The 2026-08-21 sweep is half-finished, and the half it
finished is the half that hid the problem.

That sweep put ONE word on every status PILL by routing them through
`vendor/scm/lib/status-pill.ts`. It did not touch the list FILTER TABS, which
are built from the stored value in each list's own local map — and the five
documents store that rung under four different names: Sales Order `CONFIRMED`,
Purchase Order `SUBMITTED`, GRN and Purchase Invoice `POSTED`, Sales Invoice
`SENT`. So the tab kept showing the database's word while the pill beside it
showed the screen's word.

`docs/modules/document-status-vocabulary.md` already records why those local maps
exist and calls that root fix OPEN: SIXTEEN list and detail pages declare their
own `{ tone, label }` instead of reading the shared module.

**Fix.** The rung now reads **Submitted** on the five documents the owner named,
in the canonical map and in all ten places that spell it independently.

**THE STORED VALUES ARE UNCHANGED.** Postgres enum labels are permanent, and
every report, export and AutoCount read goes to the stored value. This is the
same option A as 2026-08-21 and as the 2026-08-26 `DISPATCHED` -> "Loaded"
relabel: change the WORD, never the column. The first test in
`confirmRungReadsSubmitted.test.ts` asserts the four stored names are still four,
so a later tidy-up cannot "finish the job" by renaming a column.

**What deliberately did NOT change, and why.** The owner named five documents.
The delivery order keeps its own vocabulary by the same ruling
(「DO 则是分成 draft、load、dispatch」), and both its words were settled by him
separately — the confirm step lands on `LOADED` (2026-08-22) and `DISPATCHED`
reads "Loaded" (2026-08-26). Purchase returns, stock takes, stock transfers,
payment vouchers, consignment documents and PMS projects are not in the set
either. A sweep that renames what nobody asked about is how a consistency change
becomes a regression, so the scan below carries an explicit not-in-scope list
with the owning document written against each entry, and a third assertion that
every path on that list still exists — so it cannot rot into a blanket waiver.

**How it is pinned.** `confirmRungReadsSubmitted.test.ts`, built on the shape of
`doDispatchedReadsLoaded.test.ts`: the stored values are asserted unchanged, each
of the five is asserted through `statusLabel`, the delivery order and the three
unnamed documents are asserted to still read Confirmed, and a SOURCE SCAN over
every production `.ts`/`.tsx` fails on any line that names one of the five stored
values beside a `"Confirmed"` label. Proved RED on the unfixed tree: 7 failures,
the scan enumerating all 10 sites.

`pdf-status-label.test.ts` had hand-typed `'CONFIRMED'` as the expected printed
word for all eight documents. It now READS the expected word from
`status-pill.ts`, because the assertion that matters is "paper says what the
screen says" — a hand-typed expectation would have made the paper half of this
ruling look like a regression.

**Ref.** feat/status-reads-submitted, 2026-09-13.
