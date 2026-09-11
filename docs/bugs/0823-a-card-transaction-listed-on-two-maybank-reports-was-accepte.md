## A card transaction listed on two Maybank reports was accepted twice, and the books waited for a payout the bank makes once [medium]

<!-- area: Accounting + GL -->

**Symptom.** Maybank's merchant portal exports one CSV per merchant, day and
programme — DVS04A (credit), DVS04E (debit), T41AX (Amex), EP41 (EzyPay
instalment). An Amex card sold on an EzyPay instalment is printed on BOTH the
EP41 and the T41AX report of that day: in 2990's 14/06/2026 download,
`027012896718_EP41_713_20260614.CSV` and `027012896718_T41AX_467_20260614.CSV`
carry the same swipe — RM 3,240.00, auth code 009069, MDR RM 97.20, net
RM 3,142.80 — and differ only in the report heading and a batch number. Read
with the MBB config, both parse cleanly. Uploaded both, the second file would
have made a second batch expecting RM 3,142.80 from the bank, and its one line
would have found its payment already claimed by the first — a payout waited
for that never comes, on the largest acquirer of the lot. Owner (2026-09-11):
「可以我觉得要」.

**Root cause (traced).** `settlementUpload`
(`backend/src/scm/routes/accounting-settlement.ts`) refuses only the SAME FILE
twice (`file_hash`). Two reports of one transaction are two files, so nothing
compared the lines of a new file with the lines already on file for the
acquirer.

**Fix.** For an acquirer with unique references, the upload compares each
parsed line — trading day, reference, gross to the sen — with the acquirer's
lines already stored. A line already on another report is left out of the new
batch (its share of the fee with it, and the stated net reduced by its net so
the adjustment is unchanged), and the reply says so: `alreadyOnReport` with
the earlier file and line. A file whose lines are all already on file is
refused outright — `409 already_on_report`, naming the earlier report — and
nothing is stored. A different amount under the same day and reference is a
different transaction and is not touched; an acquirer without unique
references (GHL) is never deduplicated this way. The screen says what was
left out beside the upload result, and the refusal is curated in
`authed-fetch.ts` so its sentence reaches the operator.

Pinned by `backend/tests/settlementRoutes.test.ts` ("a transaction already
on another report": the second report keeps only its new line and names the
first; a report with nothing new is refused and stores nothing; a different
amount under the same reference is accepted; GHL is left alone). Proved RED
on the unfixed tree (the second report stored both lines, no
`alreadyOnReport`), then GREEN.

**Ref.** acc/settlement-duplicate-line-guard, 2026-09-11.
