## The Purchaser lost the Attach button on her own documents when projects.write was stripped [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-24: *"user farra as purchaser same with sim but now
farra dont have any attach button on purchaser task, fix it"* — on
JOHOR [ZANOTTI] BIGHOME @ MVEC SOUTHKEY (project 2211), the Booth Layout & Setup
table row "Stock Out Transfer Record" (item 9996) is badged **PURCHASER**, is
hers to file, and its Actions column is empty. She cannot upload the document the
whole downstream flow waits on.

**Root cause (traced).** A follow-on from **0489**, which removed
`projects.write` from the Purchaser role (id 330, Sim 84 + Farra 83) on purpose,
keeping `projects.checklist.tick` so "every role_label gate in the attach /
status / review routes now scopes them to PURCHASER-badged rows". The API does
exactly that — `POST /api/projects/checklist/:itemId/attachments`
(`backend/src/routes/projects.ts:3848,3870`) admits
`projects.write` **OR** `projects.checklist.tick` + `roleLabelAdmits(role_label,
role_name)`, and `roleLabelAdmits("PURCHASER", "Purchaser")` is true.

The DESKTOP affordance never carried that rule. Both attach gates in
`frontend/src/pages/Projects.tsx` tested `canManage` alone, which the parent
supplies as `can("projects.write")`:

- `DocumentTable` — `mayAttach = canManage || salesDirectorMayAttach(...)`, the
  gate on the Booth Layout row the owner photographed;
- `ChecklistRow` — `{canManage && (<button onClick={startAttach}...`, twice.

So the day `projects.write` left the role, the button left with it, for **both**
purchasers — this is not Farra-specific, and Sim's surviving button was mobile:
`MobilePMS.tsx` already mirrors the rule (`canAttach = canTick && (!tickOnly ||
roleMatchesUser)`), which is why the phone kept working while the PC did not.
Verified against production that the two accounts are byte-identical — same
role 330, same position 12, same permission list, neither holding
`projects.write` nor the row's `required_perm` (`stock_transfer.approve`, which
gates only the DECISION, not the upload).

**Fix.** Desktop grows the missing mirror. `roleLabelAdmitsRole(label, roleName)`
is added next to `roleLabelParts` — the same "&"-split with the DRIVER →
HELPER/STOREKEEPER extension the backend and mobile copies carry — and both
desktop attach gates become
`canManage || salesDirectorException || (canTick && roleLabelAdmitsRole(...))`.
File DELETE is deliberately NOT widened: it stays on `canManage`, matching
mobile, where removal needs `projects.manage`.

This closes the 0489 gap rather than reopening it: a purchaser gains the button
only on rows whose badge admits her role, which is the scoping 0489 asked for.

**Ref.** `fix/desktop-attach-role-label`, 2026-08-24.
