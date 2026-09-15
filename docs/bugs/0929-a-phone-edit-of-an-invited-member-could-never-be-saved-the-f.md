## A phone edit of an invited member could never be saved: the form sent status invited, which the save refuses [medium]

<!-- area: Frontend + mobile -->

**Symptom.** On the phone, Profile > Directory > a member who was invited but
has not joined yet > Edit > Save Changes always failed with "status must be
active or disabled", whatever was changed. Until that person accepted the
invite, nobody could correct their name or phone number on the phone: not a full
admin, not a Sales Director. The same form's Status box read "Active" for
someone who was not. Found 2026-09-15 while fixing 0924 (the Sales Director
phone edit); not reported by staff.

How many people it covers, from a read-only count on production (project
`anogrigyjbduyzclzjgn`, 2026-09-15 08:24 UTC): 10 invited out of 105 members
(81 active, 14 disabled), and all 10 have a name or phone on file.

**Root cause (traced).**

1. Edit opens `FORM_MEMBERS_EDIT` (`frontend/src/mobile/MobileModuleList.tsx`).
   Its Status select offers Active and Disabled, after a blank first entry that
   was labelled "Active".
2. The line it went wrong on: `seedValue` in
   `frontend/src/mobile/MobileModuleForm.tsx` copied the row's value into the
   form without checking it against the select's options, so the form held
   `"invited"`.
3. A select handed a value none of its options carry shows its first entry,
   the blank one. The screen said "Active"; the form held "invited".
4. `buildBody()` sends every non-blank field on an edit, so Save sent
   `status: "invited"`.
5. `PATCH /api/users/:id` (`backend/src/routes/users.ts`) answers 400 "status
   must be active or disabled" for any other status, before it writes anything.
   That rule is right: only the invite sets `invited`. Desktop never sends a
   status from an edit save: the member profile (`TeamMemberProfile.tsx`) and
   the classic `EditMemberPanel` send only fields that changed, and a status
   moves only through Enable / Disable.

How it was observed: the new test on the unfixed tree, 3 of 9 failing. Save's
body carried `status: "invited"`; the invited member's Status read "Active"; a
test schema sent back a stored select value it had no option for. The fake
PATCH refuses statuses with the list it reads from the handler source on
`main`. Not exercised against production.

**Fix.** One rule, in the form shared by the phone's Suppliers, Drivers, Fleet,
Warehouse racks, Departments, Positions and Members screens: `seedValue` starts
a fixed-option select only on a value it offers, else blank. What Save
sends is then what the screen shows, and a blank select on an edit is left out
of the PATCH, so the status stays as it is. An invited member's edit now saves
without a status; choosing Active or Disabled still sends it, as desktop's
Enable / Disable do. The member Status select's blank entry now reads "No
change", which is what it does on an edit: labelled "Active", choosing it on a
disabled member left them disabled.

Reach, enumerated in the PR: the schema file has 15 selects, 8 loading their
options at runtime (untouched) and 7 with fixed options. Four of the seven are
boolean columns the seed already turns into "true"/"false". Supplier status and
lorry type offer exactly the lists their PATCH routes accept, and both routes
treat a missing field as unchanged (`patchSupplierHandler` in `suppliers.ts`,
PATCH `/:id` in `lorries.ts`), so only a stored value outside the list behaves
differently: no longer sent back, where the lorry route answered 400
`invalid_type`.

Pinned by `frontend/src/mobile/mobileMemberEditInvited.test.tsx`: the statuses
the save accepts, read from the handler, are exactly the ones the phone offers;
an invited member's name and phone save with no status sent; Status reads "No
change"; choosing Disabled sends it; an active or disabled member still sends
theirs; the form-level rule on a test schema. Proved RED: 3 of 9 failed on the
unfixed tree. With PR #3933 (0924) merged in locally, its 22 tests and these 9
pass, 31 of 31, and a scoped Sales Director saving an invited member sends only
name and phone.

**Ref.** fix/mobile-member-edit-invited-status, 2026-09-15.
