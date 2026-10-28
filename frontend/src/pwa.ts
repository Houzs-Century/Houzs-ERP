/**
 * PWA wiring — service worker registration + installable / online
 * state observable. Pure logic, no UI; the install banner reads
 * from this and renders itself.
 */

let deferredPrompt: any = null;
const installListeners = new Set<(canInstall: boolean) => void>();
const onlineListeners = new Set<(online: boolean) => void>();

// Owner 2026-07-23: staff (and the owner testing his own merges) kept seeing
// the OLD build after a deploy because the running page holds the old JS in
// memory — a plain refresh often still hit the cached shell, so a change that
// merged + deployed fine "couldn't be tested" without a manual hard refresh.
// The SW already skipWaiting()s + clients.claim()s on a new build; we just
// never surfaced it. These listeners fire when a NEW build takes over so the
// UI can offer a one-tap Reload (never auto-reload — that would nuke an
// in-progress order form).
let updateAvailable = false;
const updateListeners = new Set<(available: boolean) => void>();
function notifyUpdate() {
  if (updateAvailable) return; // latch — a build only gets newer, never older
  updateAvailable = true;
  for (const fn of updateListeners) fn(true);
}

export function registerPwa() {
  // DEV: never run a service worker. On localhost the SW caches the vite
  // module graph cache-first, so edits "don't show" after a refresh until the
  // SW + caches are cleared by hand. Tear down any SW a previous prod/PWA visit
  // left registered, and wipe its caches.
  if (import.meta.env.DEV) {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    if (typeof caches !== "undefined") {
      caches
        .keys()
        .then((keys) => keys.forEach((k) => caches.delete(k)))
        .catch(() => {});
    }
  } else if ("serviceWorker" in navigator) {
    // PROD: register the SW (secure-context only; localhost is exempt but dev
    // is handled above).
    //
    // A controller already present at load means a PRIOR build is running: a
    // later controllerchange is then a version SWAP, not the first-ever
    // install — that is our "new build is live" signal.
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;

    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          // Best-effort update check on each load.
          reg.update().catch(() => {});

          // A tab left open for hours never re-checks on its own. Re-run the
          // update probe when the tab regains focus and on a slow interval so
          // a deploy that lands mid-session is still noticed.
          const recheck = () => reg.update().catch(() => {});
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") recheck();
          });
          setInterval(recheck, 60_000);

          // Backup signal: a new worker reaching "installed" while one already
          // controls the page is a waiting update. sw.js calls skipWaiting so
          // this usually rolls straight into controllerchange below, but on
          // browsers that defer activation this still surfaces it.
          reg.addEventListener("updatefound", () => {
            const installing = reg.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed" && navigator.serviceWorker.controller) {
                notifyUpdate();
              }
            });
          });
        })
        .catch((e) => {
          console.warn("[pwa] SW registration failed:", e);
        });
    });

    // Primary signal: sw.js does skipWaiting() + clients.claim(), so a fresh
    // build takes control and fires controllerchange. Guarded by
    // hadControllerAtLoad so the first-ever registration (no prior controller)
    // is not mistaken for an update.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadControllerAtLoad) notifyUpdate();
    });
  }

  // Capture the install prompt so we can replay it from a button.
  // Browsers fire `beforeinstallprompt` exactly once, so caching the
  // event is required if the user dismisses or delays.
  window.addEventListener("beforeinstallprompt", (e: any) => {
    e.preventDefault();
    deferredPrompt = e;
    notifyInstall(true);
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyInstall(false);
  });

  window.addEventListener("online", () => notifyOnline(true));
  window.addEventListener("offline", () => notifyOnline(false));
}

function notifyInstall(canInstall: boolean) {
  for (const fn of installListeners) fn(canInstall);
}
function notifyOnline(online: boolean) {
  for (const fn of onlineListeners) fn(online);
}

export function onInstallAvailability(fn: (canInstall: boolean) => void): () => void {
  installListeners.add(fn);
  // Fire synchronously with current state.
  fn(deferredPrompt != null);
  return () => installListeners.delete(fn);
}

export function onOnline(fn: (online: boolean) => void): () => void {
  onlineListeners.add(fn);
  fn(navigator.onLine);
  return () => onlineListeners.delete(fn);
}

/** Subscribe to "a newer build is live" — fires once, latched. The banner
 *  reads this to offer a one-tap Reload. Returns an unsubscribe fn. */
export function onUpdateAvailable(fn: (available: boolean) => void): () => void {
  updateListeners.add(fn);
  fn(updateAvailable);
  return () => updateListeners.delete(fn);
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    notifyInstall(false);
    return choice.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  }
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS-specific
    (window.navigator as any).standalone === true
  );
}

/** iOS Safari can't fire beforeinstallprompt — detect it so we can show a
 *  manual "Share → Add to Home Screen" guide instead. True only on
 *  iPhone/iPad Safari that ISN'T already installed (standalone). */
export function isIosInstallable(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as Mac; disambiguate by touch
    (/macintosh/i.test(ua) && "ontouchend" in document);
  // Exclude in-app webviews / Chrome-iOS (CriOS) / Firefox-iOS (FxiOS) where
  // the Share→A2HS flow differs or is unavailable.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari && !isStandalone();
}

/** Android browser that hasn't installed the app. Used by the manual
 *  "Add to Home screen" guide for the cases where the browser never fires
 *  beforeinstallprompt (Samsung Internet, MIUI browser, WebViews, or Chrome
 *  after the native prompt was declined) — when the event IS available,
 *  PwaBanners' one-tap Install banner takes precedence. */
export function isAndroidInstallable(): boolean {
  return /android/i.test(window.navigator.userAgent) && !isStandalone();
}
