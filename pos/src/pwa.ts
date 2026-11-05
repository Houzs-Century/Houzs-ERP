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

/* ── Install on this device (the Install button, like the ERP's) ─────────
 * Chrome fires beforeinstallprompt once the app qualifies; we keep the event
 * and the Install button calls prompt() on it. Listening starts at module
 * load so the event is never missed. Hidden once the app runs installed. */
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let installEvent: InstallPromptEvent | null = null;
const installListeners = new Set<(can: boolean) => void>();
const tellInstall = () => { for (const fn of installListeners) fn(installEvent !== null); };

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e as InstallPromptEvent; tellInstall(); });
  window.addEventListener("appinstalled", () => { installEvent = null; tellInstall(); });
}

/** Running as the installed app (own window), not in a browser tab. */
export const isStandalone = (): boolean =>
  typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function onInstallAvailable(fn: (can: boolean) => void): () => void {
  installListeners.add(fn);
  fn(installEvent !== null);
  return () => installListeners.delete(fn);
}

/** Open the browser's own Install box; true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = installEvent;
  if (!e) return false;
  await e.prompt();
  const choice = await e.userChoice;
  if (choice.outcome === "accepted") { installEvent = null; tellInstall(); return true; }
  return false;
}
