// ---------------------------------------------------------------------------
// chunkActionRecovery — a PRINT that hit a missing chunk reloads once onto the
// live build and reopens the same print preview.
//
// THE INCIDENT (2026-09-14): staff on HC-SO-012016 pressed Print in the preview
// and got "PDF generation failed — Failed to fetch dynamically imported module:
// https://erp.houzscentury.com/assets3/sales-order-pdf-C9QaiR37.js". That URL
// answered 404 because the tab's build had been replaced by a later deploy
// (Cloudflare Pages deploys are atomic). staleBuild.ts raised the "this tab is on
// an older version" banner, but pressing Print again failed identically: a print
// is an `await import()` inside a click handler, so no React boundary ever sees
// it and nothing reloads.
//
// THE ROOT FIX IS NOT HERE. deploy.yml now carries the previous builds' hashed
// files into every new deployment (frontend/scripts/retain-previous-assets.mjs),
// so a tab on a recent build keeps finding its chunks. This file is the safety
// net for a tab OLDER than that retention window.
//
// WHEN IT RELOADS — all of these, or it leaves the banner to do its job:
//   • the failure is PROOF a module could not be fetched (staleBuild's narrow
//     isDeployStaleEvidence, never the broad matcher);
//   • it landed while a print the operator started is in flight
//     (trackPrintAction) — a background prefetch miss must never reload a tab;
//   • the page can put the operator back where they were: a detail page whose
//     preview reopens from a resume (registerUrlPrintOpener, wired into
//     useOpenPrintPreviewFromUrl), or the list's right-click print chain;
//   • nothing on screen holds unsaved work (unsavedWork.ts);
//   • no automatic reload of this kind happened in the last
//     ACTION_RELOAD_COOLDOWN_MS (sessionStorage mark; if storage refuses, no
//     reload — an attempt we cannot remember is an attempt that repeats);
//   • one probe of the chunk gets an answer — "unknown" means the network is
//     down, and reloading into a dead network loses the page for nothing.
//
// The reload fires `beforeunload`, so a page with its own guard still asks.
// The resume reopens the PREVIEW, not the PDF: a new-tab PDF opened with no user
// gesture is popup-blocked, and the preview is one click from any exit.
// ---------------------------------------------------------------------------

import type { PrintTarget } from "./printChain";
import { chunkUrlFrom, isDeployStaleEvidence, probeChunk, type ChunkProbe } from "./staleBuild";
import { hasUnsavedWork } from "./unsavedWork";
import { onBeforeManualReload } from "./beforeManualReload";

export const ACTION_RELOAD_KEY = "chunk-action-reload";
export const PRINT_RESUME_KEY = "chunk-print-resume";
/** At most one automatic action reload per tab in this window. */
export const ACTION_RELOAD_COOLDOWN_MS = 5 * 60_000;
/** A failure this long after the click is not "during" it. Wider than any real
 *  chunk fetch; the intent is also cleared as soon as the action settles. */
export const ACTION_INTENT_TTL_MS = 30_000;
/** A resume is honoured only on the load that immediately follows. */
export const PRINT_RESUME_TTL_MS = 2 * 60_000;

export type PrintResume =
  | { kind: "preview"; open: () => void }
  | { kind: "chain"; target: PrintTarget };

export type StoredPrintResume =
  | { kind: "preview"; path: string; at: number }
  | { kind: "chain"; path: string; at: number; target: PrintTarget };

export type ActionRecoveryVerdict = "reload" | "banner" | "ignore";

export type ActionRecoveryDeps = {
  reload: () => void;
  probe: (url: string) => Promise<ChunkProbe>;
  now: () => number;
  location: { pathname: string; search: string };
};

let intent: { resume: PrintResume; at: number } | null = null;
/** A resumable print this listener declined to reload for (unsaved work, the
 *  cooldown, a network it could not reach). The banner's own Refresh button is
 *  the operator choosing to reload anyway, so it reopens this print too. */
let blocked: { resume: PrintResume; at: number } | null = null;
const urlOpeners = new Set<() => void>();

/** Run a print action with its intent recorded. Returns `run()`'s own value —
 *  the same promise object, so a rejection is still the caller's to handle.
 *  The first call installs the listener: this module loads with the print code,
 *  not on the always-loaded path, and a failure can only matter to it once a
 *  print is in flight. */
export function trackPrintAction<T>(resume: PrintResume, run: () => T, now: () => number): T {
  if (!disposeListener) installActionChunkRecovery(browserActionRecoveryDeps);
  const mine = { resume, at: now() };
  intent = mine;
  const result = run();
  const clear = () => {
    if (intent === mine) intent = null;
  };
  if (result && typeof (result as { then?: unknown }).then === "function") {
    // A side chain, never returned: its handlers swallow, so it cannot become an
    // unhandled rejection, and `result` itself is untouched.
    (result as unknown as PromiseLike<unknown>).then(clear, clear);
  }
  return result;
}

/** A page whose print preview reopens from a stored resume. */
export function registerUrlPrintOpener(open: () => void): () => void {
  urlOpeners.add(open);
  return () => {
    urlOpeners.delete(open);
  };
}

function pathOf(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

export function peekPrintResume(path: string, now: number): StoredPrintResume | null {
  try {
    const raw = sessionStorage.getItem(PRINT_RESUME_KEY);
    if (!raw) return null;
    // Read as unknown: the stored value is only as trustworthy as whatever last
    // wrote this key, which may be an older build of this module.
    const parsed = JSON.parse(raw) as { kind?: unknown; path?: unknown; at?: unknown };
    if (parsed.path !== path) return null;
    if (!(now - Number(parsed.at) <= PRINT_RESUME_TTL_MS)) return null;
    if (parsed.kind !== "preview" && parsed.kind !== "chain") return null;
    return parsed as StoredPrintResume;
  } catch {
    return null;
  }
}

export function clearPrintResume(): void {
  try {
    sessionStorage.removeItem(PRINT_RESUME_KEY);
  } catch {
    // Nothing stored can be read back either, so there is nothing to clear.
  }
}

function recentlyReloaded(now: number): boolean {
  const raw = sessionStorage.getItem(ACTION_RELOAD_KEY);
  if (!raw) return false;
  const at = Number((JSON.parse(raw) as { at?: unknown } | null)?.at ?? 0);
  return now - at < ACTION_RELOAD_COOLDOWN_MS;
}

export async function handleActionChunkFailure(
  err: unknown,
  deps: ActionRecoveryDeps,
): Promise<ActionRecoveryVerdict> {
  const now = deps.now();
  const current = intent;
  if (!current || now - current.at > ACTION_INTENT_TTL_MS) return "ignore";
  if (!isDeployStaleEvidence(err)) return "ignore";

  const { resume } = current;
  if (resume.kind === "preview" && !urlOpeners.has(resume.open)) return "banner";
  const decline = (): ActionRecoveryVerdict => {
    blocked = { resume, at: now };
    return "banner";
  };
  if (hasUnsavedWork(deps.location)) return decline();
  try {
    if (recentlyReloaded(now)) return decline();
  } catch {
    return "banner";
  }

  const url = chunkUrlFrom(err);
  if (url && (await deps.probe(url)) === "unknown") return decline();

  try {
    sessionStorage.setItem(ACTION_RELOAD_KEY, JSON.stringify({ at: now }));
    storeResume(resume, deps.location, now);
  } catch {
    clearPrintResume();
    return "banner";
  }
  if (intent === current) intent = null;
  deps.reload();
  return "reload";
}

function storeResume(resume: PrintResume, location: { pathname: string; search: string }, now: number): void {
  const path = pathOf(location);
  const stored: StoredPrintResume =
    resume.kind === "chain"
      ? { kind: "chain", path, at: now, target: resume.target }
      : { kind: "preview", path, at: now };
  sessionStorage.setItem(PRINT_RESUME_KEY, JSON.stringify(stored));
}

/** Called by the banner's Refresh button just before it reloads. If the failure
 *  it is answering was a resumable print, the preview reopens after the reload
 *  exactly as it would have after an automatic one. Deliberately does NOT write
 *  the cooldown mark: a click is not a loop. */
export function rememberBlockedPrintForReload(now: number, location: { pathname: string; search: string }): boolean {
  const current = blocked;
  if (!current || now - current.at > PRINT_RESUME_TTL_MS) return false;
  if (current.resume.kind === "preview" && !urlOpeners.has(current.resume.open)) return false;
  try {
    storeResume(current.resume, location, now);
    return true;
  } catch {
    return false;
  }
}

export const browserActionRecoveryDeps: ActionRecoveryDeps = {
  reload: () => window.location.reload(),
  probe: probeChunk,
  now: () => Date.now(),
  get location() {
    return window.location;
  },
};

let disposeListener: (() => void) | null = null;

/** The one listener, replacing any earlier one. Never calls preventDefault: the
 *  caller's own catch (the "PDF generation failed" toast) still runs, and
 *  staleBuild still raises the banner for every other case. */
export function installActionChunkRecovery(deps: ActionRecoveryDeps): () => void {
  if (typeof window === "undefined") return () => {};
  disposeListener?.();
  const onPreloadError = (event: Event) => {
    void handleActionChunkFailure((event as Event & { payload?: unknown }).payload, deps);
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  const dispose = () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    if (disposeListener === dispose) disposeListener = null;
  };
  disposeListener = dispose;
  return dispose;
}

// The banner's Refresh button: reopen a print this listener declined to reload for.
onBeforeManualReload(() => {
  if (typeof window !== "undefined") rememberBlockedPrintForReload(Date.now(), window.location);
});
