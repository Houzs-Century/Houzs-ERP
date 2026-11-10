import { useRef, useState } from "react";
import { ACCEPTED_PHOTO_TYPES, type FieldPhoto, type FieldPhotosApi } from "../lib/fieldPhotos";

/* The photo block on every field-photo screen (phone POD, phone job stop, the
   desktop job panel). State and uploads live in lib/fieldPhotos.ts; this only
   draws them.

   On a touch device the add tile opens a choice: "Take photo" (camera input
   with capture=environment) or "From photo library" (multiple, NO capture - on
   iPhone `capture` forces the camera, so a photo already taken could not be
   picked). After each shot the sheet comes back with "Take another". With a
   mouse the tile opens the file picker directly. Styles are inline with token
   fallbacks so the block looks right inside the phone shell (.hz-m) and on the
   desktop page. After a page reload the photos already uploaded come back
   (lib/fieldPhotos.ts restore); while they are being looked up, or when that
   failed, the block says so. */

const C = {
  brand: "var(--brand, #16695f)",
  red: "var(--red, #b23a3a)",
  green: "var(--green, #2f8a5b)",
  mut: "var(--mut, #767b6e)",
  line: "var(--line, #e3e6e0)",
  card: "var(--card, #ffffff)",
  ink: "var(--ink, #11140f)",
};

const STATUS_TEXT: Record<FieldPhoto["status"], string> = {
  queued: "Waiting",
  uploading: "Uploading…",
  done: "Uploaded",
  failed: "Failed",
};

function isTouch(): boolean {
  try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}

export function FieldPhotos({ api, disabled, title }: {
  api: FieldPhotosApi;
  /** True while the job is being completed: no adding, retrying or removing. */
  disabled: boolean;
  title: string;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const libraryRef = useRef<HTMLInputElement | null>(null);
  const [sheet, setSheet] = useState<null | "choose" | "added">(null);
  const { photos, max } = api;
  const full = photos.length >= max;
  const done = photos.filter((p) => p.status === "done").length;
  const busy = photos.filter((p) => p.status === "queued" || p.status === "uploading").length;
  const failed = photos.filter((p) => p.status === "failed").length;

  const openAdd = () => {
    if (disabled || full) return;
    if (isTouch()) setSheet("choose");
    else libraryRef.current?.click();
  };
  const accept = ACCEPTED_PHOTO_TYPES.join(",");

  return (
    <div data-testid="field-photos">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.mut, letterSpacing: ".04em", textTransform: "uppercase" }}>{title}</span>
        <span style={{ fontSize: 11, color: C.mut }} className="tnum">{photos.length} / {max}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))", gap: 8 }}>
        {photos.map((p, i) => (
          <div key={p.id} data-status={p.status} style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `1px solid ${p.status === "failed" ? C.red : C.line}`, background: "#eceee9", aspectRatio: "1 / 1" }}>
            {p.previewUrl
              ? <img src={p.previewUrl} alt={`Photo ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: p.status === "done" ? 1 : 0.6 }} />
              : <div style={{ display: "grid", placeItems: "center", height: "100%", fontSize: 11, color: C.mut }}>Photo {i + 1}</div>}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "3px 5px", background: "rgba(0,0,0,.55)", color: "#fff", fontSize: 10.5, fontWeight: 700, display: "flex", justifyContent: "space-between", gap: 4 }}>
              <span style={{ color: p.status === "failed" ? "#ffb3b3" : p.status === "done" ? "#b7f0cf" : "#fff" }}>{STATUS_TEXT[p.status]}</span>
            </div>
            {!disabled && (
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => api.remove(p.id)}
                style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, borderRadius: 12, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 14, lineHeight: "24px", padding: 0, cursor: "pointer" }}>×</button>
            )}
            {p.status === "failed" && !disabled && (
              <button type="button" onClick={() => api.retry(p.id)}
                style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-60%)", border: "none", borderRadius: 8, background: C.red, color: "#fff", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, padding: "6px 10px", cursor: "pointer" }}>Retry</button>
            )}
          </div>
        ))}
        {!full && (
          <button type="button" onClick={openAdd} disabled={disabled}
            style={{ aspectRatio: "1 / 1", borderRadius: 10, border: `1.5px dashed ${C.brand}`, background: C.card, color: C.brand, fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            {photos.length ? "Add photo" : "Add photos"}
          </button>
        )}
      </div>

      {(busy > 0 || failed > 0 || done > 0) && (
        <div style={{ fontSize: 11.5, marginTop: 6, color: failed ? C.red : C.mut }}>
          {[done ? `${done} uploaded` : null, busy ? `${busy} uploading` : null, failed ? `${failed} failed - tap Retry` : null].filter(Boolean).join(" · ")}
        </div>
      )}
      {photos.filter((p) => p.status === "failed" && p.error).map((p) => (
        <div key={p.id} style={{ fontSize: 11, color: C.red, marginTop: 3 }}>Photo {photos.indexOf(p) + 1}: {p.error}</div>
      ))}
      {api.notice && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>{api.notice}</div>}
      {api.restore.phase === "loading" && (
        <div style={{ fontSize: 11.5, color: C.mut, marginTop: 6 }}>Checking for photos you already uploaded for this job…</div>
      )}
      {api.restore.phase === "failed" && (
        <div role="alert" style={{ fontSize: 11.5, color: C.red, marginTop: 6 }}>
          Could not check for photos you already uploaded for this job ({api.restore.error}).
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" onClick={api.retryRestore} disabled={disabled}
              style={{ border: `1px solid ${C.brand}`, borderRadius: 8, background: C.card, color: C.brand, fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "6px 10px", cursor: "pointer" }}>Check again</button>
            <button type="button" onClick={api.skipRestore} disabled={disabled}
              style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.card, color: C.ink, fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "6px 10px", cursor: "pointer" }}>Continue without them</button>
          </div>
        </div>
      )}

      <input ref={cameraRef} type="file" accept={accept} capture="environment" style={{ display: "none" }} data-testid="field-photos-camera"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!picked.length) { setSheet(null); return; }
          api.add(picked);
          setSheet("added");
        }} />
      <input ref={libraryRef} type="file" accept={accept} multiple style={{ display: "none" }} data-testid="field-photos-library"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          setSheet(null);
          if (picked.length) api.add(picked);
        }} />

      {sheet && (
        <div role="dialog" aria-label="Add photos" onClick={() => setSheet(null)}
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(17,20,15,.4)", display: "flex", alignItems: "flex-end" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", background: "#fff", borderRadius: "18px 18px 0 0", padding: "14px 16px calc(16px + env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 8 }}>
            {sheet === "added" && (
              <div style={{ fontSize: 12.5, color: C.ink, marginBottom: 4 }}>
                Photo added. {photos.length} on this job so far. Uploads keep going while you take more.
              </div>
            )}
            {!full && (
              <button type="button" onClick={() => cameraRef.current?.click()}
                style={{ border: "none", borderRadius: 11, background: C.brand, color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 700, padding: 13, cursor: "pointer" }}>
                {sheet === "added" ? "Take another" : "Take photo"}
              </button>
            )}
            {sheet === "choose" && (
              <button type="button" onClick={() => libraryRef.current?.click()}
                style={{ border: `1px solid ${C.brand}`, borderRadius: 11, background: "#fff", color: C.brand, fontFamily: "inherit", fontSize: 14, fontWeight: 700, padding: 13, cursor: "pointer" }}>
                From photo library (pick several)
              </button>
            )}
            {full && <div style={{ fontSize: 12, color: C.mut }}>This job has the most photos it can take ({max}).</div>}
            <button type="button" onClick={() => setSheet(null)}
              style={{ border: `1px solid ${C.line}`, borderRadius: 11, background: "#fff", color: C.ink, fontFamily: "inherit", fontSize: 14, fontWeight: 600, padding: 12, cursor: "pointer" }}>
              {sheet === "added" ? "Done" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
