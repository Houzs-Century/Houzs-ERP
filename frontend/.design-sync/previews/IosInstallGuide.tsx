import { IosInstallGuide } from "autocount-sync-frontend";

// IosInstallGuide only renders on iOS Safari that hasn't installed the app
// (isIosInstallable reads navigator.userAgent + standalone). Spoof an iPhone
// Safari UA at module scope and clear the 7-day dismiss stamp so the real
// component takes its visible path.

try {
  Object.defineProperty(window.navigator, "userAgent", {
    value:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    configurable: true,
  });
  localStorage.removeItem("pwa:ios-guide:dismissed-at");
} catch {}

/** The bottom-sheet coach card: Share → Add to Home Screen. */
export const Guide = () => (
  <div className="relative h-[360px] w-[420px] bg-surface-dim">
    <div className="p-4 text-[11px] text-ink-muted">
      iPhone Safari · app not installed
    </div>
    <IosInstallGuide />
  </div>
);
