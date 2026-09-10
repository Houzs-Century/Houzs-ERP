## Desktop SO amendment — variant and compartment picks reset when a photo is uploaded or deleted [high]

**Symptom.** Owner, 2026-09-10: 「他们 delete 或者 upload 了照片，整个 colour
compartment 那些就 reset 到完了」. On the desktop SO amendment screen the
salesperson edits a sofa line — picks a fabric colour, splits into
compartments, sets the seat size — and the moment they touch photos on
that or ANY other line (upload a new one, delete an existing one), every
in-flight variant / compartment pick on the whole order snaps back to what
the server currently has. All the typing has to be redone. Present on
desktop only; mobile is unaffected.

**Root cause (traced).** Photo mutations invalidate the SO detail query,
and the desktop's edit-mode seed effect re-seeds every draft on that
refetch.

- `frontend/src/vendor/scm/components/SoLineCard.tsx:1233` — a saved-photo
  delete calls `deletePhoto.mutate(...)`.
- `frontend/src/vendor/scm/components/SoLineCard.tsx:1293` — a saved-photo
  upload calls `uploadPhoto.mutateAsync(...)`.
- `frontend/src/vendor/scm/lib/sales-order-queries.ts:660,680` — both
  mutations' `onSuccess` invalidate `['mfg-sales-order-detail', vars.docNo]`,
  which triggers a refetch of the whole SO detail.
- `frontend/src/pages/scm-v2/SalesOrderDetail.tsx:1355-1368` — a
  `useEffect` keyed on `[isEditing, items]` unconditionally rebuilt every
  `editingDrafts[itemId]` from the fresh server snapshot via
  `draftFromItem(it)`. The refetch changes the `items` reference, the
  effect fires, and every unsaved variant/compartment/pricing edit on
  every line is discarded. The comment above the effect even records the
  intent — "Re-seeds whenever the underlying items change" — but there is
  no dirty-diff, so a photo action that only touches server-side
  `photo_urls` for one line still wipes the operator's variant picks on
  every OTHER line.

Not on mobile (`frontend/src/mobile/MobileNewSO.tsx`) — that flow stages
photos into `line.photoFiles` and only uploads inside `uploadStagedPhotos`
AFTER the parent Save has diffed local `lines` against the `origItems`
snapshot and PATCHed the changes. No mid-edit refetch, no reset.

**Fix.** `SalesOrderDetail.tsx:1355-1368` now MERGES on items change
instead of overwriting: seed a fresh draft only for items that don't
already have one (a newly appeared line), drop drafts for items that no
longer exist server-side, and leave every in-flight draft alone. The
pristine snapshot `originalDraftsRef` that Save diffs against is still
refreshed from the current server items on every pass, so server-side
updates to fields the operator hasn't touched (photo_urls after upload,
stock coverage numbers) still land on Save.

**Ref.** `fix/so-desktop-photo-and-date`, 2026-09-10.
