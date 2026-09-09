## Mobile and desktop Sales Order photo uploads reported a count instead of the server's reason [high]

**Symptom.** An operator saved a Sales Order with photos attached to its lines
and was told *"3 line photo(s) failed to upload. Add them again from the SO
detail screen."* A count is not a reason. Behind that number could be an
AutoCount lock, a permission refusal, a file the server would not take, an
expired edit lease, or one dropped connection out of twelve — and "add them
again" is correct for exactly one of those. Told to re-attach against a
**refusal**, the operator re-attaches, watches it fail, and re-attaches again.

This is the same defect PR #3303 fixed for line writes on the same screen, and
that PR's ledger entry
(`docs/bugs/0723-mobile-sales-order-save-reported-a-count-instead-of-the-serv.md`)
named this instance as the one it deliberately left behind:

> **Not fixed here, same shape:** `uploadStagedPhotos` in the same file
> (`catch { failed += 1; }`, then *"N line photo(s) failed to upload"*) discards
> the reason identically for the photo path. Left out because it is a different
> operation and `MobileNewSO.tsx` is exactly on its file-size ceiling (3748).

**Root cause (traced).**

*Mobile.* `frontend/src/mobile/MobileNewSO.tsx` `uploadStagedPhotos` wrapped each
upload in a bare `catch { failed += 1; }` (line 1545 on `origin/main` at
`a473b3843`) and the caller (`:1556`) built its sentence out of the count alone.
`authedFetch` had already humanised the body to one plain operator sentence and
stashed `err.status` on the Error (`vendor/scm/lib/authed-fetch.ts`) — the same
pair #3303 recovered for line writes. Both were thrown away one line into the
client. The same function also folded a second, different outcome into that
count: a line whose saved `itemId` could not be resolved added
`failed += l.photoFiles.length` without ever reaching the network, so "the
server refused" and "we could not find the line" printed identically.

*Desktop.* `frontend/src/pages/scm-v2/SalesOrderNew.tsx` `flushPendingPhotos`
returned `{ failed, skipped }` and the caller (`:1663` on `origin/main`) rendered
`photoFailed + photoSkipped` with the fixed body *"Please re-attach on the Detail
page."* — the same wrong instruction against a refusal. It did `console.error`
the reason, which reaches a browser console no operator opens, not the dialog
they are reading. Two further defects fell out of the same shape: the
detail-fetch failure path returned `linesWithPending.length`, a count of LINES
presented as a count of PHOTOS (understated whenever a line carried more than
one), and `skipped` — an index/`item_code` mismatch — was summed with `failed`
even though it is a different thing to tell somebody.

**Fix.** New `frontend/src/vendor/scm/lib/photo-upload-failures.ts` — pure, no
React, no fetch — a SIBLING of `line-write-failures.ts` that **imports** its
capture (`lineWriteFailure`), its shared-cause collapse (`sharedFailureCause`)
and its retry decision (`isRefusal`) rather than re-implementing them, so a photo
refusal and a line refusal cannot come to disagree about what a refusal is. What
is local to the photo module is only what genuinely differs:

- the noun ("3 photos could not be uploaded", not "3 lines could not be saved");
- the retry tail. A line write may promise *"your edits are still here"*; for a
  photo that is FALSE — the staged `File` does not survive the screen — so the
  retryable tail names where to go instead (*"Add them again from the SO detail
  screen."*) and the refusal tail is *"Adding them again will not help until this
  is resolved."*;
- `photoLabel(line, file)`, because a line carries several photos and only some
  of them failed, so the item code alone does not say which one to re-attach;
- `unmatchedLinePhotos`, giving the never-reached-the-network case its own
  sentence and, deliberately, NO status — which is what the shared `isRefusal`
  reads as retryable, so the honest advice falls out of the shared rule instead
  of being special-cased.

Both call sites now collect reasons instead of counting. `MobileNewSO.tsx` is
back to **exactly 3748 lines**, its ceiling, with the reasoning kept in the
module; `SalesOrderNew.tsx` is 2300 against a ceiling of 2317.

Pinned by `frontend/src/mobile/MobileSoPhotoUploadFailureReason.test.ts`
(19 tests).

**Proved RED on the unfixed tree.** `frontend/src` on this branch was verified
byte-identical to `origin/main` (`git diff --stat origin/main -- frontend/src`
was empty), the new module was moved aside, and the test file was run:

```
FAIL  src/mobile/MobileSoPhotoUploadFailureReason.test.ts
Error: Failed to resolve import "../vendor/scm/lib/photo-upload-failures" from
"frontend/src/mobile/MobileSoPhotoUploadFailureReason.test.ts". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

That is the same RED shape #3303's first test file produced, and it is what this
PR can honestly claim: the module-level contract fails without the module. The
CALL-SITE rewrites in `MobileNewSO.tsx` and `SalesOrderNew.tsx` are covered by
`tsc -b` (the return type of `flushPendingPhotos` changed, so every reader of the
old `{ failed, skipped }` had to be updated) and by the full frontend suite — 357
files, 3958 tests, green — but **not** by a rendered-dialog test. Neither screen
has one, and neither did before this change. UNVERIFIED: no operator has seen the
new sentence on a real refusal.

This PR does NOT change what the server allows, lift any lock, or change which
uploads succeed — it only makes a failure legible.

**Not fixed here, same class:** `recordNewPayments` in `MobileNewSO.tsx`
(`:1499`) is the third instance on this screen and the last one I can see. It is
already half-way there — it keeps `firstError`, so ONE reason reaches the
operator — but it keeps no status, so its closing sentence is *"Record them again
from the SO detail screen."* unconditionally, including against a 403/409 that a
retry cannot clear; and when several payments fail for DIFFERENT reasons, only
the first is ever said. Left out because it is a different operation with a
different retry story (a re-posted payment is money, not a photo, and the
idempotency key is part of that answer), and because `MobileNewSO.tsx` is at its
ceiling — the reasoning module already exists, so the remaining work is the call
site plus a decision about what re-posting a payment should promise.

**Ref.** `fix/mobile-photo-upload-reason`, 2026-09-09. Follows #3303.
