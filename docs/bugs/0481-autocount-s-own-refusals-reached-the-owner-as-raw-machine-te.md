## AutoCount's own refusals reached the owner as raw machine text, and the queue had no in-flight guard [medium]

<!-- area: AutoCount sync + write-back -->

The owner, 2026-08-20, reading the AutoCount Sync page: **「这些全部都是看的，能简单
化一点吗？看的好复杂，就直接跟我们说什么被拒绝就可以了」** and **「为什么写这种的呢？
没有平时 autocount reject 的 reason 直接过来？」**

**Symptom.** Two kinds of row, two completely different standards of explanation.
A document the ERP held back read as a plain-language headline, a sentence, a
**TO FIX** line and a collapsed *Technical detail* holding the machine's note. A
document AUTOCOUNT refused read as a generic headline — "AutoCount would not take
this document" — with the account book's raw string pasted underneath it:
`Primary Key Error`. Three words, naming nothing the reader could act on, on the
screen the owner uses to decide whether the accounts are in step.

**Root cause (traced, not guessed).** `acReasonCopy`
(`frontend/src/lib/autocountOutbox.ts`) had plain words for every ERP refusal —
keyed by the server's `reason_kind` — and for AutoCount's answers had only the
single generic `AC_FAILED_COPY`. `acWhatWasSaid` then folded the machine text
into the disclosure **only** when `source === "erp"`, so an AutoCount answer could
never move off the face of the row. Both were right when written and for the same
reason: the only notes the page had words for were the ERP's, so "who wrote it"
and "do we have words for it" were the same condition. Nobody had noticed they
had stopped being the same question. **It was an oversight, not a design** — the
disclosure the raw text belongs in already existed, on the other rows.

**Fix.** `AC_AUTOCOUNT_SAID`: a small dictionary of AutoCount's own refusals with
the same three parts the ERP's get, and `acWhatWasSaid`'s branch now turns on
whether the page has SPECIFIC words rather than on who spoke. Deliberately thin —
**only strings actually observed go in it**, each carrying where it was seen, and
anything unmatched still falls through to the generic copy that quotes AutoCount
verbatim. A wrong plain-language explanation is worse than an untranslated one,
because it sends an operator to repair something that is not broken; this page has
already done that once (see `AC_FAILED_COPY`'s own comment). One entry today:
`Primary Key Error`, observed in production on three documents.

`AC_FAILED_COPY` is excluded from "specific" alongside `AC_UNRECOGNISED_COPY`,
because its own TO FIX line says *"Read AutoCount's own words below"* — folding
the quote away would have left an instruction pointing at something no longer on
screen.

**Second defect, found while building the manual push and latent until then.**
`drainAutoCountOutbox` SELECTs pending rows and calls `dispatchOne` on each, and
**nothing between those two steps marked a row as in-flight**: no lock, no lease,
no conditional UPDATE, and `mark()` carries no status predicate. It was safe for
exactly one reason — there was a single dispatcher, the 5-minute cron, and one
caller cannot race itself. Adding a "Send now" button makes a human the second
dispatcher, and two presses (or a press landing inside a sweep) would have put one
document into a licensed account book twice. Migration 0315 adds `claimed_at`;
both dispatchers now take an exclusive claim through a single conditional UPDATE,
`mark()` releases it on every outcome, and `releaseExpiredClaims` expires a claim
whose Worker was killed mid-send so a document can never be stranded.

**A third, caught by its own test before it shipped.** The first wording for the
`send-now-retrying` outcome said *"AutoCount could not be reached"*. It is wrong:
`AcSyncService` turns every exception into a 500 and `callAcService` treats a 500
as retryable, so a document AutoCount is actively REFUSING sits at `pending`
carrying that refusal until its sixth attempt — which is where `HC-SO-2608-002`
was while `HC-SO-2608-001` beside it read `failed` with identical words. The
sentence would have sent an operator to check a tunnel that was working perfectly
and refusing him on purpose. It now says only what is true of both cases and shows
the book's own words underneath. Same reason `pending` rows get the translation
too, not just `failed` ones.

**Ref.** PR (2026-08-20) — `feat/ac-manual-push`. Evidence for the `Primary Key
Error` wording is workflow run 32382073444; what the account book actually holds
under those numbers is UNKNOWN and named as such in
`docs/modules/autocount-writeback.md` §7g.
