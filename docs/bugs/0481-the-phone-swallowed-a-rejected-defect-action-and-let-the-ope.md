## The phone swallowed a rejected defect action and let the operator walk away [high]

<!-- area: Projects + PMS + fair report -->

**白话.** 在手机上把缺陷照片盖成「Done」，如果后端拒绝了这个动作，画面上**什么都
不会说** —— 转圈停了，草稿还在，看起来就像存好了。人就这样走了，以为那个缺陷已经
结案。电脑版一直都会跳错误提示，只有手机版不会。现在手机也会说了。

**Symptom.** On mobile, a user stamps a defect-list photo `Done` (or `Replace`),
presses Save, the server refuses, the spinner stops — and **nothing on screen says
it did not save**. The draft stays open, which reads as "still editing" rather than
"failed". Desktop has always toasted the same failure
(`Projects.tsx` `saveAction` → `toast?.error(e?.message || "Failed to save")`).

**Root cause (traced).** Same endpoint, same payload, on both surfaces
(`POST /api/projects/checklist/attachments/:id/actions`, `{status, remark}`).
`MobilePMS.tsx`'s `DefectFileActions.save()` ended in a bare
`catch { }` holding only a comment about keeping the draft. The intent — keep the
draft so the retry is one tap — was right; discarding the reason was not, and the
two are independent.

**And the refusal is REACHABLE, not theoretical.** The `canReview` / `canPurchase`
derivations that decide whether the buttons render at all are byte-identical on the
two surfaces and are re-derived on the CLIENT from `position_name` / `role_name`
regexes, with **no backend capability behind them**. So the button can appear for
someone the server will refuse — which is exactly the case whose failure was being
thrown away. (The gate itself is unchanged here; this entry is about the silence.)

**Fix.** The catch now names the failure through `useNotify()` — the server's own
words, `tone: "error"` — and still keeps the draft. Not a bare catch, so the
`audit:swallowed-reads` ratchet is not fed; its census is unchanged at the ceiling.

`DefectActionsCtx` + `DefectFileActions` moved out of `MobilePMS.tsx` into
`frontend/src/mobile/MobilePmsDefectActions.tsx`. The reason is testability:
`MobilePMS.tsx` is 4,300+ lines and importing it into a test drags in the whole PMS
surface, so the save path could not be driven directly. Extracted, it renders with
two mocks. `MobilePMS.tsx` shrank 4,475 → 4,355 lines (the extraction plus the dead
`uploadTransfer` from entry 0480), which is under its ratchet ceiling and pays for
itself.

**Test.** `frontend/src/mobile/MobilePmsDefectActions.test.tsx` — 3 tests driving
the real component. Proved RED against the pre-fix bare catch (restored
temporarily to measure it): `expected "vi.fn()" to be called 1 times, but got 0
times`, and `expected "vi.fn()" to be called at least once`. The third — a
successful save clears the draft, reloads, and says nothing — was GREEN before and
after, so the fix is pinned as "surface failures" and not "surface everything".

**Ref.** `fix/pms-transfer-date-and-swallowed-error`, 2026-08-21.
