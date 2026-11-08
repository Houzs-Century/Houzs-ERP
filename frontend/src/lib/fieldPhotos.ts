/* Field photos (POD, job stop, the office backing up a job): the shared logic
   layer behind components/FieldPhotos.tsx, used by the phone screens
   (MobilePOD, MobileJobStop) and the desktop job panel alike.

   Each photo is uploaded THE MOMENT IT IS PICKED, one at a time, instead of all
   at Complete. A photo held only in the page's memory was lost whenever iOS
   reloaded the page under the camera, or the signal dropped at the customer's
   door - and then Complete failed as a whole. Now every photo has its own
   state (queued -> uploading -> done | failed) with Retry and Remove, and
   Complete sends only the keys of photos that are done; while any photo is
   still uploading or failed, Complete says so instead of failing.

   Not in scope (stated in the PR): an offline queue. A failed upload stays on
   screen as failed until Retry; a page reload still forgets photos that had
   not finished uploading. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { stampLines, stampNow, stampPhoto } from "./photoStamp";

export type FieldPhotoStatus = "queued" | "uploading" | "done" | "failed";

export type FieldPhoto = {
  id: string;
  /** What is uploaded: the stamped copy once stamping ran, the original before. */
  file: File;
  stamped: boolean;
  previewUrl: string | null;
  status: FieldPhotoStatus;
  key: string | null;
  error: string | null;
};

export type FieldPhotosAction =
  | { type: "add"; photos: FieldPhoto[] }
  | { type: "start"; id: string }
  | { type: "stamped"; id: string; file: File }
  | { type: "done"; id: string; key: string }
  | { type: "failed"; id: string; error: string }
  | { type: "retry"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear" };

export function fieldPhotosReducer(state: FieldPhoto[], a: FieldPhotosAction): FieldPhoto[] {
  const patch = (id: string, p: Partial<FieldPhoto>) => state.map((x) => (x.id === id ? { ...x, ...p } : x));
  switch (a.type) {
    case "add": return [...state, ...a.photos];
    case "start": return patch(a.id, { status: "uploading", error: null });
    case "stamped": return patch(a.id, { file: a.file, stamped: true });
    // A result for a photo already removed is ignored by patch (no such id).
    case "done": return patch(a.id, { status: "done", key: a.key, error: null });
    case "failed": return patch(a.id, { status: "failed", error: a.error });
    case "retry": return state.map((x) => (x.id === a.id && x.status === "failed" ? { ...x, status: "queued" as const, error: null } : x));
    case "remove": return state.filter((x) => x.id !== a.id);
    case "clear": return [];
  }
}

/** The next photo to upload, or null while one is already uploading
 *  (uploads go one at a time, so a weak signal is not split five ways). */
export function nextToUpload(state: FieldPhoto[]): FieldPhoto | null {
  if (state.some((x) => x.status === "uploading")) return null;
  return state.find((x) => x.status === "queued") ?? null;
}

export type CompletionGate = { ok: true; keys: string[] } | { ok: false; reason: string };

/** May the job be completed with these photos? Only done photos count, and a
 *  photo still in flight or failed blocks with a message that says which. */
export function completionGate(state: FieldPhoto[], noneMessage: string): CompletionGate {
  const pending = state.filter((x) => x.status === "queued" || x.status === "uploading").length;
  const failed = state.filter((x) => x.status === "failed").length;
  const keys = state.filter((x) => x.status === "done" && x.key).map((x) => x.key as string);
  if (pending) return { ok: false, reason: `${pending} photo${pending === 1 ? " is" : "s are"} still uploading. Wait until ${pending === 1 ? "it shows" : "they show"} Uploaded, then complete.` };
  if (failed) return { ok: false, reason: `${failed} photo${failed === 1 ? "" : "s"} did not upload. Tap Retry, or Remove ${failed === 1 ? "it" : "them"}, then complete.` };
  if (!keys.length) return { ok: false, reason: noneMessage };
  return { ok: true, keys };
}

/** How many of `incoming` fit under `max`, and what to tell the user about the
 *  rest - never a silent cut. */
export function admit(current: number, incoming: number, max: number): { take: number; message: string | null } {
  const room = Math.max(0, max - current);
  const take = Math.min(room, incoming);
  if (take === incoming) return { take, message: null };
  return { take, message: `At most ${max} photos per job. ${incoming - take} photo${incoming - take === 1 ? " was" : "s were"} not added.` };
}

let seq = 0;
function newId(): string {
  seq += 1;
  try { return crypto.randomUUID(); } catch { return `fp-${Date.now()}-${seq}`; }
}

function previewFor(file: File): string | null {
  try { return URL.createObjectURL(file); } catch { return null; }
}

export type FieldPhotosApi = {
  photos: FieldPhoto[];
  max: number;
  /** A capacity or file-type message from the last add, or null. */
  notice: string | null;
  add: (files: File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  gate: (noneMessage: string) => CompletionGate;
};

export const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * @param stampLabel the DO / job number burned into each photo with the server
 *   time; null = do not stamp (the office adding photos it was sent - the time
 *   on them would be the office's, not the photo's).
 * @param upload the upload call; returns the stored key (uploadFieldPhoto).
 */
export function useFieldPhotos({ stampLabel, max, upload }: {
  stampLabel: string | null;
  max: number;
  upload: (file: File) => Promise<{ r2Key: string }>;
}): FieldPhotosApi {
  const [photos, dispatch] = useReducer(fieldPhotosReducer, []);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(new Set<string>());
  const latest = useRef({ stampLabel, upload });
  latest.current = { stampLabel, upload };
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Revoke every preview when the screen goes away.
  useEffect(() => () => { for (const p of photosRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); }, []);

  const next = nextToUpload(photos);
  useEffect(() => {
    if (!next) return;
    const { id } = next;
    // One upload per attempt, even if the effect runs twice for the same state.
    const attempt = `${id}:${next.error ?? ""}:${photosRef.current.indexOf(next)}`;
    if (started.current.has(attempt)) return;
    started.current.add(attempt);
    let file = next.file;
    const stamped = next.stamped;
    dispatch({ type: "start", id });
    void (async () => {
      try {
        const label = latest.current.stampLabel;
        if (!stamped && label !== null) {
          const lines = stampLines(label, await stampNow());
          file = await stampPhoto(file, lines);
          dispatch({ type: "stamped", id, file });
        }
        const { r2Key } = await latest.current.upload(file);
        dispatch({ type: "done", id, key: r2Key });
      } catch (e) {
        dispatch({ type: "failed", id, error: (e as Error).message || "Upload failed. Check the signal and tap Retry." });
      } finally {
        started.current.delete(attempt);
      }
    })();
  }, [next]);

  const add = useCallback((files: File[]) => {
    const bad = files.filter((f) => !(ACCEPTED_PHOTO_TYPES as readonly string[]).includes(f.type));
    const good = files.filter((f) => !bad.includes(f));
    const { take, message } = admit(photosRef.current.length, good.length, max);
    const parts = [bad.length ? `${bad.length} file${bad.length === 1 ? " is" : "s are"} not a JPEG, PNG or WebP photo and ${bad.length === 1 ? "was" : "were"} not added.` : null, message].filter(Boolean);
    setNotice(parts.length ? parts.join(" ") : null);
    const fresh = good.slice(0, take).map((file): FieldPhoto => ({
      id: newId(), file, stamped: false, previewUrl: previewFor(file), status: "queued", key: null, error: null,
    }));
    if (fresh.length) dispatch({ type: "add", photos: fresh });
  }, [max]);

  const remove = useCallback((id: string) => {
    const p = photosRef.current.find((x) => x.id === id);
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setNotice(null);
    dispatch({ type: "remove", id });
  }, []);

  const clear = useCallback(() => {
    for (const p of photosRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setNotice(null);
    dispatch({ type: "clear" });
  }, []);

  const retry = useCallback((id: string) => dispatch({ type: "retry", id }), []);
  const gate = useCallback((noneMessage: string) => completionGate(photosRef.current, noneMessage), []);

  return { photos, max, notice, add, retry, remove, clear, gate };
}
