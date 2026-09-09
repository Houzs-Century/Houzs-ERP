## The Cleared-tab fix corrected one of the two lines that read the wrong total [medium]

**Follow-up to `docs/bugs/0705-the-cleared-tab-counted-its-documents-against-a-total-that-e.md`,
which is right about the cause and did not finish.** That entry traces the
defect and introduces `acListTotal(d, state)`; this one is about the half of the
page it did not reach.

**Symptom.** The owner photographed the AutoCount Sync page and asked what had
gone wrong. His screenshot shows **two** broken sentences, not one:

```
Cleared | 3 of 1 document        <- the filter strip
Showing 1–3 of 1 document        <- the line that closes the register
```

0705 fixed the first. The second went on saying "of 1 document" on the desktop
page **and** on the phone screen, so the page still contradicted itself two
inches lower down — and the sentence still on screen was the more visible of the
two, sitting directly under the three rows it was miscounting.

**Root cause of the MISS (traced).** Both lines read `d.counts.total`, in four
places:

| | filter strip (`acListCountLine`) | closing line (`acShowingLine`) |
|---|---|---|
| `frontend/src/pages/AutoCountSync.tsx` | :956 — fixed by 0705 | **:1009 — missed** |
| `frontend/src/mobile/MobileAutoCountSync.tsx` | :763 — fixed by 0705 | **:838 — missed** |

The two helpers live in different modules — `acListCountLine` in
`autocountOutbox.ts`, `acShowingLine` in `autocountRegister.ts` — and the
register module's own comment says why they are two: one answers *"how much did
the filters leave"* and the other *"am I looking at all of it"*. Two questions,
two sentences, and **one shared denominator** that nothing named as shared. A
search for the symptom finds the helper that was wrong; it does not find the
second helper that was fed the same wrong argument.

**This is the repo's known "fix one surface, not the other" class, one level
tighter** — not desktop versus mobile (0705 did both of those correctly), but two
call sites *on the same surface* reading one field.

**Fix.** Both closing lines now call `acListTotal(d, state)` — 0705's helper,
not a second one. **A second helper would have been the more expensive bug**: a
rule with two homes is how this repo got three different answers to "did a person
edit this row" living in one file.

**Tests.** `acListTotal` shipped with **no test of any kind** — there is no
`acListTotal` in any `*.test.ts` on `main` — which is why nothing objected to
half the call sites still bypassing it. Four now sit in
`frontend/src/lib/autocountArchive.test.ts`, and they deliberately pin the
COMPOSITION as well as the rule, because the rule alone was never what broke:

```
FAIL > counts the Cleared tab against the cleared shelf
  AssertionError: expected 1 to be 3
FAIL > no longer closes the register with three of one
  AssertionError: expected 'Showing 1–3 of 1 document' to be 'Showing 1–3 of 3 documents'
FAIL > says none of zero on a Cleared tab nobody has used
  AssertionError: expected 'Showing none of 9 documents' to be 'Showing none of 0 documents'
 Tests  3 failed | 1 passed | 11 skipped (15)
```

Proved RED by returning `d.counts.total` from `acListTotal` — the pre-0705
behaviour — and the middle failure is the owner's screenshot, character for
character. The one that passes in both directions is the control: every
non-Cleared tab must go on dividing by the live total, and it does.

**Lesson, and it is not "check both call sites".** When a fix introduces a
helper because a field was being read directly, the same change should ask what
ELSE reads that field, and the answer belongs in the PR as an enumeration. Here
`grep -n "counts.total" frontend/src` was a two-second question nobody asked, and
it names all four sites.

**Ref.** PR pending, 2026-09-08. Follows
`docs/bugs/0705-the-cleared-tab-counted-its-documents-against-a-total-that-e.md`.
Guide: `docs/modules/autocount-writeback.md`.
