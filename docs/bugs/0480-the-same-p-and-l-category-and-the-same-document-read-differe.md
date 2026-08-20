## The same P&L category and the same document read differently on desktop and mobile [medium]

<!-- area: Projects + PMS + fair report -->

**白话.** 同一个项目、同一份 P&L，电脑上写「COGS — Matt/Sofa」，手机上写
「Cogs Matt Sofa」—— 两个人看同一张单，念出来的科目名字不一样。同一份文件也一样：
标题后面多加了「(Revision 2)」，手机上有审批按钮，电脑上一个都没有。付款状态也是，
电脑写「Fully paid」，手机写「Paid」。现在这三份名单只剩一份，两边一起读。

**Symptom.** Three vocabularies, hand-written on both surfaces:

1. **P&L category labels.** Desktop `catLabel()` mapped the ledger slugs
   explicitly (`cogs_matt_sofa` → "COGS — Matt/Sofa"). Mobile ran a generic
   `humanize()` (underscores → spaces, title-case) over EVERY finance line and
   every sales line. The same row read **"COGS — Matt/Sofa" on the PC and
   "Cogs Matt Sofa" on the phone.**
2. **Reviewable documents.** Desktop `REVIEWABLE_TITLES` was a Set of seven
   EXACT titles tested with `.has(item.title)`. Mobile was a PREFIX regex whose
   comment claimed it "mirrors" the desktop set. It is strictly broader, so a
   checklist item titled **"3D Design (Revision 2)"** or **"Agreement — signed
   copy"** got the submit/approve/reject workflow on the phone and showed **no
   review controls at all** on the PC.
3. **Project status + payment pills.** The three status values agreed, so no live
   bug — but the next status added would have appeared on desktop and silently
   not on the phone. The sibling list had already drifted exactly that way: the
   `fully_paid` pill read **"Fully paid"** on desktop and **"Paid"** on mobile.

**Root cause (traced).** Not one bug — one SHAPE, three times. Each copy was
written by someone who needed a word in a surface that could not reach the one
that already had it, and none of the three lists was DB-backed or shared. The
repo had already solved this once for the workflow STAGE vocabulary
(`vendor/scm/lib/pms-status.ts`, whose header says both surfaces had hardcoded
those too) — the pattern simply had not been applied to the other three.

**Fix.** Three sibling modules next to `pms-status.ts`, imported by both
surfaces: `pms-ledger-categories.ts`, `pms-reviewable-titles.ts`,
`pms-project-status.ts`. They were EXTRACTED from `Projects.tsx`, not copied
beside it — that file is the largest in the repo and sits above its ceiling,
which may only fall, so the extraction had to pay for itself. It did:
**15,126 → 15,079 lines**, and `MobilePMS.tsx` net zero.

Only the value→label contract is shared. Each surface keeps its own visual map
(desktop Tailwind chip/ring + calendar hex, mobile inline styles), which is the
same split `pms-status.ts` chose and the reason sharing was safe here.

**A JUDGEMENT, stated rather than slipped in: `isReviewableTitle` is the PREFIX
rule.** The prefix matcher is a strict SUPERSET of the exact set — every one of
the seven exact titles matches its own prefix, which the test PROVES rather than
assumes — so adopting it removes review controls from nobody. What changes is
that DESKTOP now shows submit/approve/reject on suffixed rows, which mobile
already did. Chosen because staff type these titles by hand and add suffixes, an
exact match withholds the workflow invisibly (the row just renders without
buttons), and the owner's standing philosophy for this system is to loosen
rather than restrict. **Raised for the owner in the PR, not decided quietly.**
If he wants exactness, the matcher changes in one place and both surfaces follow.

**Test.** `pms-vocabulary-one-home.test.ts` — 11 source-scan assertions, ALL RED
on the unfixed tree (six "imports the shared X" plus five "declares its own copy"),
following `backend/tests/assrStageLabelOneHome.test.ts`: a behaviour test cannot
see the failure mode, because the way this returns is a call site quietly growing
its own table again, which renders fine and errors nowhere.
`pms-vocabulary.test.ts` — 12 tests on the words themselves, including the
superset proof that makes the prefix choice safe, and the negative case that
keeps it a PREFIX and not a substring ("Photo of 3D Design" is not reviewable).

**Ref.** `fix/pms-shared-vocabulary`, 2026-08-21.
