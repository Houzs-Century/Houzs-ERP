## The purchasers could not delete files on their own documents on PC [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-09-02: *"check user sim why she cant see button delete
for file? fix it now for pc"*, then, with a screenshot of a file card showing
only Download: *"here no icon delete. add for sim task only, same with farra"*.

**Root cause (traced).** The third instalment of the same split that produced
0546, and the direct consequence of the choice recorded at the end of it. 0489
removed `projects.write` from the Purchaser role (330: Sim 84, Farra 83) so the
role_label gates would scope them to PURCHASER-badged rows; 0546 then taught the
desktop ATTACH gates that rule but **deliberately left DELETE alone** — "it stays
on canManage, matching the stricter mobile rule". With neither `projects.write`
nor `projects.manage`, the purchasers therefore saw no trash on the very
documents they file.

The API was never the constraint. `DELETE /api/projects/checklist/attachments/:attId`
(`backend/src/routes/projects.ts:3983`) admits `projects.write` **OR**
`projects.checklist.tick` + `roleLabelAdmits(role_label, role_name)`, and its own
comment says so. Three desktop gates disagreed with it:

- `TaskAttachmentRow` — `canManage && canDeleteFile`, where `canDeleteFile` is
  `can("projects.manage")`. This is the card in the owner's screenshot.
- `ChecklistRow`'s file-chip trash — `canManage && !readOnlyAttach && a.id > 0`,
  under a comment already claiming it is "shown to whoever can attach here",
  which stopped being true the moment attach was widened in 0546.
- Both `TaskAttachmentRow` call sites passed `itemTitle` but never the item's
  `role_label`, so the component could not have applied the rule anyway.

**Fix.** `TaskAttachmentRow` takes `roleLabel` (passed at both call sites) and
computes `mayDeleteFile = attachment.id > 0 && ((canManage && canDeleteFile) ||
(canTick && roleLabelAdmitsRole(roleLabel, role_name)))`; the chip trash reuses
`mayAttachRow`, restoring the equivalence its own comment asserts. The manager
path is kept, not replaced.

Scoped exactly as the owner asked — "sim task only": simulated over the real
badges, `PURCHASER→Purchaser` shows the trash while `BD→Purchaser`,
`SALES PIC→Purchaser` and `SALES PIC & DRIVER→Purchaser` do not, which is why
the BD-badged Display Floor Plan in the screenshot correctly still has none.
`attachment.id < 0` (a merged crew phase photo) stays non-removable; that guard
used to ride on `canManage` and is now asserted directly.

The rule itself moved out of the 15,000-line component into
`frontend/src/auth/roleLabelAdmits.ts` with unit tests, which is also what let
this land: the file-size ratchet charges GROWTH, and extracting the helper took
`Projects.tsx` to **-1** line against its merge base instead of +21.

Pinned by two source-scans in `frontend/src/auth/projectActionGates.test.ts` —
one on the trash gates, one asserting every `<TaskAttachmentRow` is handed its
badge (the predicate silently answers false without it). **Proved RED against
`origin/main`**: 4 of the 5 assertions failed there, the manager rule being the
one that legitimately passed on both trees.

**Widened mid-flight, before this merged.** Shown the PC-only scoping, the owner
replaced the rule outright: *"every user can delete/remove file or image from
their own task, both pc and mobile pms"* (2026-09-03). That **retires the
2026-08-05 managers-only rule** on both surfaces, so the divergence flagged in
the first draft of this entry no longer exists.

Delete now simply follows ATTACH: the task you may put a file on is the task you
may take one off, which is what "their own task" means for either kind of caller
— `projects.write` edits the row, a tick-only role is scoped to its own badge.
Mobile turned out to carry **three** delete gates, not one, each now on its own
edit right: the file chip (`canRemoveFile = canAttach`), the document tiles
(`canDeleteFiles = canTick`, with `!t.readOnly` already applied at every use
site) and the floor-plan card (`canDeleteFiles = canWrite`). The old rule had
left crew and sales able to upload a wrong photo they could not then remove.

Mobile's own inline copy of the badge rule collapsed into the shared
`auth/roleLabelAdmits` at the same time, which is what kept `MobilePMS.tsx`
under its 4491 ceiling (4487 → 4483) while gaining this behaviour.

**Ref.** `fix/purchaser-delete-own-files`, 2026-09-02.
