/* Service worker registration and the "Update available" signal (layout
 * P17). A new build installs in the background and WAITS; only the login
 * screen offers "Restart now", which tells the waiting worker to take over
 * and reloads. Selling is never interrupted and pending sales live in
 * IndexedDB, untouched by a reload. Dev never registers a worker. */
declare const __POS_VERSION__: string;
export const APP_VERSION: string = typeof __POS_VERSION__ === "string" ? __POS_VERSION__ : "dev";

type Listener = (waiting: boolean) => void;
const listeners = new Set<Listener>();
let waitingWorker: ServiceWorker | null = null;

export function onUpdateAvailable(fn: Listener): () => void {
  listeners.add(fn);
  fn(waitingWorker !== null);
  return () => listeners.delete(fn);
}

function setWaiting(w: ServiceWorker | null) {
  waitingWorker = w;
  for (const fn of listeners) fn(w !== null);
}

export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (reg.waiting) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed" && navigator.serviceWorker.controller) setWaiting(reg.waiting ?? sw);
          });
        });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      })
      .catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

/** "Restart now": the waiting build takes over and the page reloads. */
export function applyUpdate(): void {
  if (!waitingWorker) return;
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function checkForUpdate(): void {
  navigator.serviceWorker?.getRegistration().then((r) => r?.update().catch(() => {})).catch(() => {});
}
