import { AndroidInstallGuide } from "autocount-sync-frontend";

// AndroidInstallGuide renders on Android browsers where beforeinstallprompt
// never fired (Samsung Internet, MIUI browser, WebViews, declined Chrome
// prompt) — the manual fallback to PwaBanners' one-tap Install. Spoof an
// Android Chrome UA, clear the dismiss stamp, and shrink the
// wait-for-prompt grace so the capture catches the visible state.

try {
  Object.defineProperty(window.navigator, "userAgent", {
    value:
      "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36",
    configurable: true,
  });
  localStorage.removeItem("pwa:android-guide:dismissed-at");
} catch {}

/** The bottom-sheet coach card: browser menu → Add to Home screen. */
export const Guide = () => (
  <div className="relative h-[360px] w-[420px] bg-surface-dim">
    <div className="p-4 text-[11px] text-ink-muted">
      Android · beforeinstallprompt unavailable
    </div>
    <AndroidInstallGuide graceMs={150} />
  </div>
);
