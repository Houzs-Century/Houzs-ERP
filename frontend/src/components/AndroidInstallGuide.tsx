import { useEffect, useState } from "react";
import { MoreVertical, Plus, X } from "lucide-react";
import { isAndroidInstallable, onInstallAvailability } from "../pwa";
import { shouldShowPwaPrompt } from "./pwaDismissal";

/**
 * AndroidInstallGuide — manual "Add to Home screen" coach for Android
 * browsers where beforeinstallprompt never fires (Samsung Internet, MIUI
 * browser, in-app WebViews, or Chrome after the native prompt was declined).
 * When the event IS available, PwaBanners' one-tap Install banner takes
 * precedence and this guide stays hidden. Shows once per 7-day cool-off;
 * hidden once installed (standalone). Theme C, mirrors IosInstallGuide.
 */
const DISMISS_KEY = "pwa:android-guide:dismissed-at";
const NAG_AFTER_DAYS = 7;
// Give beforeinstallprompt a moment to arrive before deciding the browser
// won't fire it — Chrome dispatches it shortly after load when eligible.
const PROMPT_GRACE_MS = 2500;

export function AndroidInstallGuide({
  graceMs = PROMPT_GRACE_MS,
}: {
  /** Wait for beforeinstallprompt before showing the manual steps. */
  graceMs?: number;
} = {}) {
  const [show, setShow] = useState(false);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => onInstallAvailability(setCanInstall), []);

  useEffect(() => {
    if (!isAndroidInstallable()) return;
    const t = setTimeout(() => {
      try {
        setShow(shouldShowPwaPrompt(DISMISS_KEY, NAG_AFTER_DAYS));
      } catch {
        setShow(true);
      }
    }, graceMs);
    return () => clearTimeout(t);
  }, [graceMs]);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setShow(false);
  }

  // The one-tap install banner (PwaBanners) is available — defer to it.
  if (!show || canInstall) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-md rounded-2xl border border-border bg-surface px-[18px] py-4 shadow-slab">
      <div className="flex items-start gap-3">
        <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-ink">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-primary font-display text-[12px] font-semibold text-white">
            H
          </span>
        </div>
        <div className="flex-1">
          <div className="text-[13.5px] font-bold text-ink">
            Add to Home screen
          </div>
          <div className="mt-1 space-y-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-ink">1.</span>
              Tap the
              <MoreVertical size={14} className="text-primary" strokeWidth={2} />
              menu at the top right
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-ink">2.</span>
              Choose “Add to Home screen”
              <Plus size={14} className="text-primary" strokeWidth={2} />
              or “Install app”
            </div>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
