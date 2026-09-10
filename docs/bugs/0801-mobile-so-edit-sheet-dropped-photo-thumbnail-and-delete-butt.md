## Mobile SO edit sheet dropped photo thumbnail and delete button [high]

**Symptom.** Owner 2026-09-11 on HC-SO-007678 (mobile Sales Order):

- On the SO detail view an existing line (e.g. "Hugh Duncan King Size")
  showed its reference photos correctly. Tapping **Edit** on the
  SUBMITTED order dropped the operator into the mobile edit sheet where
  the same line rendered *no photo* — only a small camera icon and a
  "SAVED" text pill. There was no way to tell whether the photo was
  still there, and no way to remove one.

**Root cause (traced).** In `frontend/src/mobile/MobileNewSO.tsx` the
saved-photo tile at L3197-3230 (before this change) rendered a
text-only placeholder for every `line.photoKeys` entry:

```tsx
{line.photoKeys.map((k) => (
  <div key={k} style={photoTile}>
    <div style={{ ...photoTileInner, background: "#e1efed", ..., }}>SAVED</div>
  </div>
))}
```

Two independent bugs sit in that one block:

1. **No image.** The tile draws the literal text "SAVED", never an
   `<img>`. The comment above (L3236-3238) admitted the intent — *"the
   full thumbnail lives on the SO detail screen; here we show a compact
   marker so the operator knows photos exist without a signed-URL
   round-trip"*. That claim is false in this codebase: `MobileSODetail.tsx`
   has zero references to `photo_urls` / `photoKeys` in its line
   rendering (L1038-1126 grep clean); only the header-level
   `ScannedPhotosCard` shows a picture, and that is the order-slip scan,
   not a per-line photo. So the "full thumbnail on the detail screen"
   never existed on mobile.

2. **No delete button.** The tile carried no `onRemove`. Only the
   `StagedPhotoThumb` (L3249) — used for this-session uploads not yet
   posted to R2 — had the `✕`. There was no path in the mobile UI to
   remove a persisted photo. `useDeleteSoItemPhoto` was not even
   imported.

Desktop (`SoLineCard.tsx`) already renders the real thumbnail via
`useScmLinePhoto` + the delete X via `useDeleteSoItemPhoto`. Mobile was
never ported when photos landed there.

**Fix.** New `MobileSavedPhotoThumb` component in `MobileNewSO.tsx`
that:

- Fetches a signed URL through `useScmLinePhoto("so", photoKey, docNo,
  itemId)` — the same shared state machine desktop
  `SoLinePhotoStrip` runs (thumb → full → authed-proxy fallback +
  `onImgError` refetch).
- Renders `<img src={photo.src}>` inside the existing 52×52 tile chrome,
  falling back to the "…" / "ERR" text placeholder until the URL
  resolves.
- Adds a delete X that calls `useDeleteSoItemPhoto.mutate({docNo, itemId,
  photoKey})` and, on success, tells the parent to drop the key from
  `line.photoKeys` so the tile disappears without a full refetch (which
  would otherwise fire the SO detail re-seed and cost network for no UI
  gain).

`LineCard` gains an optional `soDocNo?: string` prop, plumbed through
from `MobileNewSO`'s `docNo` prop. The New-SO path leaves `soDocNo`
undefined and `line.itemId` empty, so the map falls through to the old
SAVED marker for that branch — but that branch is unreachable in
practice (a new line has no `photoKeys` to render). Keeping the
fallback avoids a silent tile drop if the invariant ever breaks.

**Verification.** `npm --prefix frontend run typecheck` clean. The
delete mutation is the exact one desktop `SoLineCard.tsx:1234` uses,
including the `X-SO-Edit-Lease` header the server requires — so a
SUBMITTED-state order that server refuses to edit will surface the
refusal to the caller through the shared `writeFailed` toast, not
silently.

Not touching desktop `SoLineCard.tsx` or `SoLinePhotoStrip.tsx` — both
are already correct for their surfaces. Mobile view mode
(`MobileSODetail.tsx`) still does not render line photos in the
line-by-line list; that is a separate rework (out of scope here; owner
did not report seeing the wrong thing in view mode on this order —
those three drawer sketches in the screenshot are the item-level
photos of a *different* line, HILTON (A)-(K), and they show because
they are inside `ScannedPhotosCard`'s scan-slip section, not per line).

**Ref.** `fix/mobile-edit-photo-thumb-and-delete`, 2026-09-11.
