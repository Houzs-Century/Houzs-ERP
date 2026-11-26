
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
  if (updateAvailable) return;
  updateAvailable = true;
  for (const fn of updateListeners) fn(true);
}

export function registerPwa() {
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
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;

    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          reg.update().catch(() => {});

          const recheck = () => reg.update().catch(() => {});
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") recheck();
          });
          setInterval(recheck, 60_000);

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

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadControllerAtLoad) notifyUpdate();
    });
  }

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
    (window.navigator as any).standalone === true
  );
}

/** iOS Safari can't fire beforeinstallprompt — detect it so we can show a
 *  manual "Share → Add to Home Screen" guide instead. True only on
 *  iPhone/iPad Safari that ISN'T already installed (standalone). */
export function isIosInstallable(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && "ontouchend" in document);
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
