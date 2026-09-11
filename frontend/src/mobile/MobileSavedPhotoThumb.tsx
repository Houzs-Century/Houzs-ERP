import { useEffect, useMemo, type CSSProperties } from "react";
import { useDeleteSoItemPhoto } from "../vendor/scm/lib/sales-order-queries";
import { useScmLinePhoto } from "../vendor/scm/lib/so-line-photo";

/* Photo-tile chrome shared by the saved and the staged tiles below. Sized 52
   square to sit next to the compact camera button in the mobile SO line
   editor; positioned relative so the delete X can absolute-corner over it. */
const photoTile: CSSProperties = {
  width: 52, height: 52, flex: "none", borderRadius: 9, overflow: "hidden",
  border: "1px solid #d6d9d2", position: "relative",
};
const photoTileInner: CSSProperties = {
  width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
};

/* Saved (persisted, edit-mode) photo tile for the mobile Sales Order line
   editor. Fetches a signed URL via the shared useScmLinePhoto state machine
   (same one desktop SoLinePhotoStrip uses) so the operator sees the real
   thumbnail, and offers a delete X wired to the versioned photo-delete
   mutation (X-SO-Edit-Lease header, same as desktop SoLineCard). The parent
   drops the key from `line.photoKeys` on success so the tile disappears
   without a full refetch.

   Owner 2026-09-11, HC-SO-007678 mobile edit: was a text-only "SAVED"
   placeholder with no image and no delete button — trace in
   `docs/bugs/0801-mobile-so-edit-sheet-dropped-photo-thumbnail-and-delete-butt.md`.

   Lives in its OWN file (with StagedPhotoThumb, its sibling below) to keep
   MobileNewSO.tsx under its size ceiling. */
export function MobileSavedPhotoThumb({
  docNo, itemId, photoKey, onDeleted,
}: {
  docNo: string; itemId: string; photoKey: string; onDeleted: () => void;
}) {
  const photo = useScmLinePhoto("so", photoKey, docNo, itemId);
  const deleteMut = useDeleteSoItemPhoto();
  const busy = deleteMut.isPending;
  return (
    <div style={photoTile}>
      {photo.src ? (
        <img
          src={photo.src}
          alt=""
          onError={photo.onImgError}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div style={{ ...photoTileInner, background: "#e1efed", color: "#16695f", fontSize: 8, fontWeight: 700, letterSpacing: ".04em" }}>
          {photo.error ? "ERR" : "..."}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (busy) return;
          deleteMut.mutate({ docNo, itemId, photoKey }, { onSuccess: () => onDeleted() });
        }}
        disabled={busy}
        title="Remove"
        style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, borderRadius: 999, border: "none", background: "rgba(17,20,15,.75)", color: "#fff", fontSize: 12, lineHeight: 1, cursor: busy ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
      >{"✕"}</button>
    </div>
  );
}

/* Staged (this-session) photo — object-URL preview + a delete X. Revokes the
   URL on unmount / file change (mirrors the desktop pendingPreviews). */
export function StagedPhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div style={photoTile}>
      <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <button
        type="button"
        onClick={onRemove}
        title="Remove (not uploaded yet)"
        style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 999, border: "none", background: "rgba(17,20,15,.7)", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      >{"✕"}</button>
    </div>
  );
}
