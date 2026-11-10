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

   A page reload (iOS often reloads the page under the camera) no longer loses
   the photos that had finished uploading: with `restore`, the screen asks the
   server for this stop's uploaded, not yet completed photos when it mounts and
   shows them again as Uploaded. Until that answer is in, Complete waits, so a
   job is never completed without photos the crew already took. Remove also
   tells the server, so a removed photo does not come back.

   Not in scope: an offline queue. A photo that had NOT finished uploading when
   the page reloaded is still lost (it lived only in the page's memory), and a
   failed upload stays on screen as failed until Retry. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { stampLines, stampNow, stampPhoto } from "./photoStamp";
import {
  ALLOWED_SLIP_MIMES, discardFieldPhoto, fieldPhotoImagePath, listFieldPhotos,
} from "../vendor/scm/lib/slip";
import { api as apiClient } from "../api/client";

export type FieldPhotoStatus = "queued" | "uploading" | "done" | "failed";

export type FieldPhoto = {
  id: string;
  /** What is uploaded: the stamped copy once stamping ran, the original before.
   *  null for a photo re-listed from the server after a reload. */
  file: File | null;
  stamped: boolean;
  previewUrl: string | null;
  status: FieldPhotoStatus;
  key: string | null;
  /** The upload session, so Remove can tell the server; null until uploaded. */
  sessionId: string | null;
  error: string | null;
};

export type FieldPhotosAction =
  | { type: "add"; photos: FieldPhoto[] }
  | { type: "start"; id: string }
  | { type: "stamped"; id: string; file: File }
  | { type: "done"; id: string; key: string; sessionId: string | null }
  | { type: "restore"; photos: FieldPhoto[] }
  | { type: "preview"; id: string; url: string }
  | { type: "failed"; id: string; error: string }
  | { type: "retry"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear" };

export function fieldPhotosReducer(state: FieldPhoto[], a: FieldPhotosAction): FieldPhoto[] {
  const patch = (id: string, p: Partial<FieldPhoto>) => state.map((x) => (x.id === id ? { ...x, ...p } : x));
  switch (a.type) {
    case "add": return [...state, ...a.photos];
    // Re-listed after a reload: put back only what the screen does not already hold.
    case "restore": {
      const have = new Set(state.map((x) => x.key).filter(Boolean));
      const fresh = a.photos.filter((x) => x.key && !have.has(x.key));
      return fresh.length ? [...fresh, ...state] : state;
    }
    case "preview": return patch(a.id, { previewUrl: a.url });
    case "start": return patch(a.id, { status: "uploading", error: null });
    case "stamped": return patch(a.id, { file: a.file, stamped: true });
    // A result for a photo already removed is ignored by patch (no such id).
    case "done": return patch(a.id, { status: "done", key: a.key, sessionId: a.sessionId, error: null });
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

/** Where the re-list of already-uploaded photos stands. `skipped` = the crew
 *  chose to go on without it after it failed. */
export type RestoreState =
  | { phase: "off" }
  | { phase: "loading" }
  | { phase: "done" }
  | { phase: "failed"; error: string }
  | { phase: "skipped" };

/** May the job be completed with these photos? Only done photos count, and a
 *  photo still in flight or failed blocks with a message that says which. While
 *  the photos already uploaded for this stop are still being looked up (or the
 *  lookup failed and nobody chose to go on), Complete waits: completing then
 *  would leave out photos the crew already took. */
export function completionGate(state: FieldPhoto[], noneMessage: string, restore: RestoreState): CompletionGate {
  if (restore.phase === "loading") return { ok: false, reason: "Checking for photos you already uploaded for this job. Try again in a moment." };
  if (restore.phase === "failed") return { ok: false, reason: `Could not check for photos you already uploaded for this job (${restore.error}). Tap Check again, or Continue without them.` };
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
  restore: RestoreState;
  /** After a failed re-list: ask the server again. */
  retryRestore: () => void;
  /** After a failed re-list: go on without the photos uploaded earlier. */
  skipRestore: () => void;
  /** A capacity or file-type message from the last add, or null. */
  notice: string | null;
  add: (files: File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  gate: (noneMessage: string) => CompletionGate;
};

/* The upload pipeline's own whitelist (slip.ts), images only: one home, so a
   type the server refuses is never offered here. */
export const ACCEPTED_PHOTO_TYPES: readonly string[] = ALLOWED_SLIP_MIMES.filter((m) => m.startsWith("image/"));

/** How a screen gets back the photos it had already uploaded. `key` names the
 *  stop; the list is fetched again whenever it changes. */
export type FieldPhotoRestore = {
  key: string;
  list: () => Promise<Array<{ uploadSessionId: string; r2Key: string }>>;
  /** A displayable URL for one uploaded photo (a blob URL; revoked on unmount). */
  preview: (uploadSessionId: string) => Promise<string>;
  discard: (uploadSessionId: string) => Promise<void>;
};

/** The server-backed restore for one stop (context from fieldPhotoContext). */
export function serverFieldPhotoRestore(context: string): FieldPhotoRestore {
  return {
    key: context,
    list: () => listFieldPhotos(context),
    preview: (id) => apiClient.fetchBlobUrl(fieldPhotoImagePath(id)),
    discard: (id) => discardFieldPhoto(id),
  };
}

/**
 * @param stampLabel the DO / job number burned into each photo with the server
 *   time; null = do not stamp (the office adding photos it was sent - the time
 *   on them would be the office's, not the photo's).
 * @param upload the upload call; returns the stored key (uploadFieldPhoto).
 * @param restore how to get back photos already uploaded for this stop after a
 *   reload (serverFieldPhotoRestore); null = this screen does not re-list (not
 *   loaded yet, or the job is already completed).
 */
export function useFieldPhotos({ stampLabel, max, upload, restore }: {
  stampLabel: string | null;
  max: number;
  upload: (file: File) => Promise<{ r2Key: string; uploadSessionId?: string | null }>;
  restore: FieldPhotoRestore | null;
}): FieldPhotosApi {
  const [photos, dispatch] = useReducer(fieldPhotosReducer, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>(restore ? { phase: "loading" } : { phase: "off" });
  const [restoreNonce, setRestoreNonce] = useState(0);
  const started = useRef(new Set<string>());
  const latest = useRef({ stampLabel, upload, restore });
  latest.current = { stampLabel, upload, restore };
  const restoreKey = restore?.key ?? null;
  const restoreStateRef = useRef(restoreState);
  restoreStateRef.current = restoreState;
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Revoke every preview when the screen goes away.
  useEffect(() => () => { for (const p of photosRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); }, []);

  useEffect(() => {
    const r = latest.current.restore;
    if (!r || restoreKey === null) { setRestoreState({ phase: "off" }); return; }
    // An object, not a let: the cleanup flips it while the list is in flight.
    const run = { live: true };
    setRestoreState({ phase: "loading" });
    void (async () => {
      let rows: Array<{ uploadSessionId: string; r2Key: string }>;
      try {
        rows = await r.list();
      } catch (e) {
        if (run.live) setRestoreState({ phase: "failed", error: (e as Error).message || "no connection" });
        return;
      }
      if (!run.live) return;
      const back = rows.map((row): FieldPhoto => ({
        id: newId(), file: null, stamped: true, previewUrl: null, status: "done", key: row.r2Key, sessionId: row.uploadSessionId, error: null,
      }));
      dispatch({ type: "restore", photos: back });
      setRestoreState({ phase: "done" });
      for (const p of back) {
        // A thumbnail that cannot load still leaves the photo counted and sent.
        r.preview(p.sessionId as string).then((url) => {
          if (run.live) dispatch({ type: "preview", id: p.id, url }); else URL.revokeObjectURL(url);
        }, () => {});
      }
    })();
    return () => { run.live = false; };
  }, [restoreKey, restoreNonce]);

  const next = nextToUpload(photos);
  useEffect(() => {
    if (!next) return;
    const { id } = next;
    // One upload per attempt, even if the effect runs twice for the same state.
    const attempt = `${id}:${next.error ?? ""}:${photosRef.current.indexOf(next)}`;
    if (started.current.has(attempt)) return;
    started.current.add(attempt);
    const file = next.file;
    const stamped = next.stamped;
    dispatch({ type: "start", id });
    void (async () => {
      try {
        // Only a photo re-listed from the server has no file, and it is never queued.
        if (!file) throw new Error("This photo is no longer on the phone. Remove it and take it again.");
        let toSend: File = file;
        const label = latest.current.stampLabel;
        if (!stamped && label !== null) {
          const lines = stampLines(label, await stampNow());
          toSend = await stampPhoto(toSend, lines);
          dispatch({ type: "stamped", id, file: toSend });
        }
        const { r2Key, uploadSessionId } = await latest.current.upload(toSend);
        dispatch({ type: "done", id, key: r2Key, sessionId: uploadSessionId ?? null });
      } catch (e) {
        dispatch({ type: "failed", id, error: (e as Error).message || "Upload failed. Check the signal and tap Retry." });
      } finally {
        started.current.delete(attempt);
      }
    })();
  }, [next]);

  const add = useCallback((files: File[]) => {
    const bad = files.filter((f) => !ACCEPTED_PHOTO_TYPES.includes(f.type));
    const good = files.filter((f) => !bad.includes(f));
    const { take, message } = admit(photosRef.current.length, good.length, max);
    const parts = [bad.length ? `${bad.length} file${bad.length === 1 ? " is" : "s are"} not a JPEG, PNG or WebP photo and ${bad.length === 1 ? "was" : "were"} not added.` : null, message].filter(Boolean);
    setNotice(parts.length ? parts.join(" ") : null);
    const fresh = good.slice(0, take).map((file): FieldPhoto => ({
      id: newId(), file, stamped: false, previewUrl: previewFor(file), status: "queued", key: null, sessionId: null, error: null,
    }));
    if (fresh.length) dispatch({ type: "add", photos: fresh });
  }, [max]);

  const remove = useCallback((id: string) => {
    const p = photosRef.current.find((x) => x.id === id);
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setNotice(null);
    dispatch({ type: "remove", id });
    const r = latest.current.restore;
    if (r && p?.status === "done" && p.sessionId) {
      r.discard(p.sessionId).catch((e: unknown) => {
        setNotice(`Removed here, but the server was not told (${(e as Error).message || "no connection"}). It may show again if the page reloads; remove it again then.`);
      });
    }
  }, []);

  const clear = useCallback(() => {
    for (const p of photosRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setNotice(null);
    dispatch({ type: "clear" });
  }, []);

  const retry = useCallback((id: string) => dispatch({ type: "retry", id }), []);
  const gate = useCallback((noneMessage: string) => completionGate(photosRef.current, noneMessage, restoreStateRef.current), []);
  const retryRestore = useCallback(() => setRestoreNonce((n) => n + 1), []);
  const skipRestore = useCallback(() => setRestoreState((s) => (s.phase === "failed" ? { phase: "skipped" } : s)), []);

  return { photos, max, restore: restoreState, retryRestore, skipRestore, notice, add, retry, remove, clear, gate };
}
