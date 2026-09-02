## Two documents said the photo upload never ran, and it had [medium]

**Symptom.** The owner asked on 2026-09-02 whether the AutoCount line
photographs were all in. He was told 207 sales and purchase lines might render
nothing, and asked to go and open a document to settle it. Those 207 lines were
fine, and had been since 2026-08-31. He spent attention on a problem that did
not exist.

**Root cause (traced).** Not code — two documents that were true when written
and were never revisited. `docs/ac-resync-runbook.md` 阶段 3b step 2 said
「到 2026-08-31 为止**一次 R2 上传都没做过**(token 档还没建)」 and marked its
success block 「示意的形状,不是跑过的纪录」;
`docs/ac-reimport-2026-08-28-ledger.md` said 「R2 一次都没传过(token 档还没建)」.
Both sentences were written earlier on 2026-08-31, before the upload. The upload
then ran at 04:16-04:58 UTC — ahead of the two attach runs at 04:44 / 05:05,
exactly the order the runbook prescribes — and neither file was updated.

The answer was then built from those two sentences plus a correct observation
that pointed the same way: the photo key embeds the ERP row id, the 2026-08-28
re-import replaced every row id, and 207 rows carry only a key minted on
2026-08-31. Every link in that chain was true. The conclusion was still wrong,
because the one thing nobody did was ask the bucket.

**Fix.** Ask the bucket, then correct the record.
`upload-line-photos-r2.mjs MODE=verify` re-read 25 of the 602 SO keys on fresh
processes: `25 byte-identical to the manifest; 0 present but unverifiable; 0
missing; 0 wrong — VERDICT: PASSED`. Separately, all 840 keys minted that day
were fetched through R2's REST API
(`GET /accounts/<acct>/r2/buckets/houzs-erp/objects/<key>`; `HEAD` answers 405,
so GET): every one `200 image/jpeg`, and invented keys answer
`404 {"code":10007}` — the discriminator is live, which is the check that stops
a sweep of 200s from meaning nothing.

Both documents now carry the measured run in place of the stale sentence, and
the ledger keeps the original struck through rather than deleted, because the
wrong sentence is the lesson.

The sweep also refuted a SECOND claim, in
`backend/scripts/data/r2-{so,po}-photo-keys-2026-08-10.txt`, whose headers
asserted round-1 had verified those keys 「one-by-one with 0 missing」. 64 of
them answer 404 today: 55 are stale duplicates beside a live key on the same
row, and 9 leave a row showing nothing (SO `HC-SO-009031`, `HC-SO-012907`; PO
`HC-PO-008483`, `HC-PO-008461`, `HC-PO-008944`, `HC-PO-009018`, `HC-PO-009024`,
`HC-PO-009034`, `HC-PO-009709`). What removed them is UNKNOWN. Both headers now
say so.

**No test pins this**, and that is worth stating rather than hiding: the
assertion lives in prose about an external bucket, and the repo deliberately
holds no R2 credential in CI. What replaces a test is the habit the entry is
filed under — when a document makes a claim about an operation, run the
operation before repeating the claim. `CLAUDE.md` already carries the rule ("a
number in a comment is a fact with an expiry date", and rule 3 on remedy
claims); this is the second time it has been paid for, and the first time the
bill went to the owner rather than to a session.

**Ref.** `diag/photo-doc-level`, 2026-09-02. Measured alongside PR #2896's
photo-gap probe.
