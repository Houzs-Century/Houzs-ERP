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

   The crew share one stop (owner, 2026-11-10): the list is EVERY crew member's
   pending photos for the stop, with who took each, and it is asked again every
   `pollMs` while the screen is open (and right after a Remove), so the driver's
   photo shows on the helper's phone and a photo the other removed, or a
   Complete the other made, leaves this one. A photo another person took cannot
   be removed here unless the server says this caller may (its uploader or the
   stop's lead).

   Not in scope: an offline queue. A photo that had NOT finished uploading when
   the page reloaded is still lost (it lived only in the page's memory), and a
   failed upload stays on screen as failed until Retry. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { stampLines, stampNow, stampPhoto } from "./photoStamp";
import { ALLOWED_SLIP_MIMES } from "../vendor/scm/lib/slip";
import {
  CREW_STOP_POLL_MS, crewStopPhotoImagePath, discardCrewStopPhoto, listCrewStopPhotos,
} from "../vendor/scm/lib/crew-stop-photos";
import { api as apiClient } from "../api/client";

/* A photo must never sit on "Uploading" for ever (HC-DO-2611-151, 2026-11-11: an
   iPhone photo stuck while the driver could not complete). Stamping decodes the
   photo on a canvas, which iOS can leave pending with no error on a large image;
   the upload itself has a fetch timeout but the compression inside it does not.
   So: the clock read and the stamp fall back (phone time / the unstamped photo)
   after a short wait, and the whole upload gives up after UPLOAD_WATCHDOG_MS and
   shows the photo as failed with Retry. */
export const CLOCK_TIMEOUT_MS = 5_000;
export const STAMP_TIMEOUT_MS = 20_000;
export const UPLOAD_WATCHDOG_MS = 90_000;
const UPLOAD_STALLED = new Error("The upload stalled. Check the signal and tap Retry, or Remove the photo.");

/** `p`, or after `ms` the fallback: a value resolves, an Error rejects. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T | Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => (fallback instanceof Error ? reject(fallback) : resolve(fallback)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

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
  /** Who took it, when another crew member did; null for this phone's own. */
  uploadedBy: string | null;
  canRemove: boolean;
  /** The server has listed it, so its absence from a later list means it was
   *  removed or completed elsewhere (a photo just uploaded here may not be
   *  listed yet, and must not vanish). */
  serverSeen: boolean;
};

export type FieldPhotosAction =
  | { type: "add"; photos: FieldPhoto[] }
  | { type: "start"; id: string }
  | { type: "stamped"; id: string; file: File }
  | { type: "done"; id: string; key: string; sessionId: string | null }
  | { type: "restore"; photos: FieldPhoto[] }
  | { type: "sync"; photos: FieldPhoto[] }
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
    // A later list from the server: new crew photos come in, the ones it no
    // longer lists (removed or completed by someone else) go, this phone's
    // uploads it has not listed yet stay.
    case "sync": {
      const incoming = new Map(a.photos.filter((x) => x.key).map((x) => [x.key as string, x]));
      let changed = false;
      const kept: FieldPhoto[] = [];
      for (const x of state) {
        const got = x.status === "done" && x.key ? incoming.get(x.key) : undefined;
        if (got) {
          incoming.delete(x.key as string);
          if (x.uploadedBy !== got.uploadedBy || x.canRemove !== got.canRemove || !x.serverSeen) {
            changed = true;
            kept.push({ ...x, uploadedBy: got.uploadedBy, canRemove: got.canRemove, serverSeen: true, sessionId: x.sessionId ?? got.sessionId });
          } else kept.push(x);
        } else if (x.status === "done" && x.serverSeen) {
          changed = true;
        } else kept.push(x);
      }
      const fresh = [...incoming.values()];
      if (!fresh.length && !changed) return state;
      return [...fresh, ...kept];
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
  if (restore.phase === "loading") return { ok: false, reason: "Checking for photos already uploaded for this job. Try again in a moment." };
  if (restore.phase === "failed") return { ok: false, reason: `Could not check for photos already uploaded for this job (${restore.error}). Tap Check again, or Continue without them.` };
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
  /** A background re-list failed; the next one retries. null when the last worked. */
  syncError: string | null;
  add: (files: File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  gate: (noneMessage: string) => CompletionGate;
};

/* The upload pipeline's own whitelist (slip.ts), images only: one home, so a
   type the server refuses is never offered here. */
export const ACCEPTED_PHOTO_TYPES: readonly string[] = ALLOWED_SLIP_MIMES.filter((m) => m.startsWith("image/"));

export type ListedFieldPhoto = {
  uploadSessionId: string;
  r2Key: string;
  uploadedBy?: { name: string | null } | null;
  mine?: boolean;
  canRemove?: boolean;
};

/** How a screen gets back the photos already uploaded for its stop. `key` names
 *  the stop; the list is fetched again whenever it changes, and every `pollMs`
 *  (null = only on mount). */
export type FieldPhotoRestore = {
  key: string;
  pollMs: number | null;
  list: () => Promise<ListedFieldPhoto[]>;
  /** A displayable URL for one uploaded photo (a blob URL; revoked on unmount). */
  preview: (uploadSessionId: string) => Promise<string>;
  discard: (uploadSessionId: string) => Promise<void>;
};

/** The server-backed restore for one stop (context from fieldPhotoContext):
 *  every crew member's pending photos for it, asked again while the screen is open. */
export function serverFieldPhotoRestore(context: string): FieldPhotoRestore {
  return {
    key: context,
    pollMs: CREW_STOP_POLL_MS,
    list: () => listCrewStopPhotos(context),
    preview: (id) => apiClient.fetchBlobUrl(crewStopPhotoImagePath(id, context)),
    discard: (id) => discardCrewStopPhoto(id, context),
  };
}

function listedToPhoto(row: ListedFieldPhoto): FieldPhoto {
  return {
    id: newId(), file: null, stamped: true, previewUrl: null, status: "done", key: row.r2Key, sessionId: row.uploadSessionId, error: null,
    uploadedBy: row.mine === false ? (row.uploadedBy?.name || "another crew member") : null,
    canRemove: row.canRemove ?? true,
    serverSeen: true,
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
  const [syncError, setSyncError] = useState<string | null>(null);
  // Bumped by a Remove so the list is asked again at once, not at the next poll.
  const [syncNonce, setSyncNonce] = useState(0);
  // Keys removed on this phone: a list already in flight must not bring them back.
  const removedKeys = useRef(new Set<string>());
  const syncSeq = useRef(0);
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

  const showPreviews = (r: FieldPhotoRestore, photos: FieldPhoto[], run: { live: boolean }) => {
    for (const p of photos) {
      // A thumbnail that cannot load still leaves the photo counted and sent.
      r.preview(p.sessionId as string).then((url) => {
        if (run.live) dispatch({ type: "preview", id: p.id, url }); else URL.revokeObjectURL(url);
      }, () => {});
    }
  };
  const listed = (rows: ListedFieldPhoto[]) => rows.filter((row) => !removedKeys.current.has(row.r2Key)).map(listedToPhoto);

  useEffect(() => {
    const r = latest.current.restore;
    if (!r || restoreKey === null) { setRestoreState({ phase: "off" }); return; }
    // An object, not a let: the cleanup flips it while the list is in flight.
    const run = { live: true };
    setRestoreState({ phase: "loading" });
    void (async () => {
      let rows: ListedFieldPhoto[];
      const seq = ++syncSeq.current;
      try {
        rows = await r.list();
      } catch (e) {
        if (run.live) setRestoreState({ phase: "failed", error: (e as Error).message || "no connection" });
        return;
      }
      if (!run.live || seq !== syncSeq.current) return;
      const back = listed(rows);
      dispatch({ type: "restore", photos: back });
      setRestoreState({ phase: "done" });
      const have = new Set(photosRef.current.map((x) => x.key));
      showPreviews(r, back.filter((p) => !have.has(p.key)), run);
    })();
    return () => { run.live = false; };
  }, [restoreKey, restoreNonce]);

  // The crew's later changes: asked again every pollMs while the stop is open
  // (not while the phone is in a pocket with the screen off), and after a Remove.
  const restoreDone = restoreState.phase === "done" || restoreState.phase === "skipped";
  useEffect(() => {
    const r = latest.current.restore;
    if (!r || restoreKey === null || !restoreDone) return;
    const run = { live: true };
    const sync = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const seq = ++syncSeq.current;
      let rows: ListedFieldPhoto[];
      try {
        rows = await r.list();
      } catch (e) {
        if (run.live) setSyncError((e as Error).message || "no connection");
        return;
      }
      // An older answer than one already applied is dropped.
      if (!run.live || seq !== syncSeq.current) return;
      setSyncError(null);
      const incoming = listed(rows);
      const have = new Set(photosRef.current.map((x) => x.key));
      dispatch({ type: "sync", photos: incoming });
      showPreviews(r, incoming.filter((p) => !have.has(p.key)), run);
    };
    if (syncNonce > 0) void sync();
    const timer = r.pollMs ? setInterval(() => { void sync(); }, r.pollMs) : null;
    return () => { run.live = false; if (timer) clearInterval(timer); };
  }, [restoreKey, restoreDone, syncNonce]);

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
          const clock = await withTimeout(stampNow(), CLOCK_TIMEOUT_MS, { at: new Date(), source: "device" as const });
          toSend = await withTimeout(stampPhoto(toSend, stampLines(label, clock)), STAMP_TIMEOUT_MS, toSend);
          dispatch({ type: "stamped", id, file: toSend });
        }
        const { r2Key, uploadSessionId } = await withTimeout(latest.current.upload(toSend), UPLOAD_WATCHDOG_MS, UPLOAD_STALLED);
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
      uploadedBy: null, canRemove: true, serverSeen: false,
    }));
    if (fresh.length) dispatch({ type: "add", photos: fresh });
  }, [max]);

  const remove = useCallback((id: string) => {
    const p = photosRef.current.find((x) => x.id === id);
    if (p && !p.canRemove) return;
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setNotice(null);
    dispatch({ type: "remove", id });
    const r = latest.current.restore;
    if (r && p?.status === "done" && p.sessionId) {
      if (p.key) removedKeys.current.add(p.key);
      r.discard(p.sessionId).then(() => setSyncNonce((n) => n + 1), (e: unknown) => {
        if (p.key) removedKeys.current.delete(p.key);
        setNotice(`Removed here, but the server was not told (${(e as Error).message || "no connection"}). It may show again; remove it again then.`);
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

  return { photos, max, restore: restoreState, retryRestore, skipRestore, notice, syncError, add, retry, remove, clear, gate };
}
