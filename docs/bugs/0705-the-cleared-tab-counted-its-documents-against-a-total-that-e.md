## The Cleared tab counted its documents against a total that excludes them [low]

**Symptom.** Observed on production on 2026-09-08, minutes after the Cleared tab
shipped and the owner's three old test documents were cleared: the tab listed
three documents under the line **"3 of 1 document"**. Same wrong denominator on
the phone.

**Root cause (traced).** `acListCountLine(shown, total)` is fed
`d.counts.total`, and `counts.total` is deliberately *the number of documents ON
the page* — every list statement and both count scans now carry
`archived_at IS NULL`, so a cleared document is not in it. That is right for the
four ordinary filters, where the reader is being shown a slice of the company's
live queue, and wrong for the one filter that looks at the other shelf. The
correct denominator for that tab is `counts.archived`, which the route already
publishes and which the chip beside the line was already reading — so the two
numbers on the same screen disagreed about the same set.

**Fix.** `acListTotal(d, state)` in `frontend/src/lib/autocountOutbox.ts` —
`counts.archived` under `archived`, `counts.total` everywhere else — used by
both surfaces. Two tests in `frontend/src/lib/autocountOutbox.test.ts`: one
reproduces the exact production shape (`archived: 3, total: 1`) and asserts
`"3 of 3 documents"`, one asserts the four ordinary filters are unchanged.

Worth an entry rather than a silent amend: this page's whole design is about
numbers that cannot contradict each other on one screen — the route counts
DOCUMENTS rather than sends for that reason, and the banner refuses to say
"everything is in AutoCount" when the scan was partial for that reason. Shipping
a new self-contradicting number on it, on the same day, is exactly the class the
ledger exists to stop recurring.

**Ref.** fix/cleared-tab-denominator, 2026-09-08.
