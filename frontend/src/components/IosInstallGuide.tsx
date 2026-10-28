import { useEffect, useState } from "react";
import { Share, Plus, X } from "lucide-react";
import { isIosInstallable } from "../pwa";
import { shouldShowPwaPrompt } from "./pwaDismissal";

/**
 * IosInstallGuide — manual "Add to Home Screen" coach for iOS Safari, which
 * never fires beforeinstallprompt (so PwaBanners' auto prompt can't appear).
 * Shows once per 7-day cool-off; hidden once installed (standalone). Theme C.
 */
const DISMISS_KEY = "pwa:ios-guide:dismissed-at";
const NAG_AFTER_DAYS = 7;

export function IosInstallGuide() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isIosInstallable()) return;
    try {
      setShow(shouldShowPwaPrompt(DISMISS_KEY, NAG_AFTER_DAYS));
    } catch {
      setShow(true);
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setShow(false);
  }

  if (!show) return null;

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
            Add to Home Screen
          </div>
          <div className="mt-1 space-y-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-ink">1.</span>
              Tap the
              <Share size={14} className="text-primary" strokeWidth={2} />
              Share button at the bottom
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-ink">2.</span>
              Choose “Add to Home Screen”
              <Plus size={14} className="text-primary" strokeWidth={2} />
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
