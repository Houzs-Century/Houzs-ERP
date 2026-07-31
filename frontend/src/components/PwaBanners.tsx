import { useEffect, useState } from "react";
import { CompanyMark } from "./CompanyMark";
import { shortCompanyName } from "../lib/branding";
import { useBranding } from "../hooks/useBranding";
import { Download, WifiOff, X } from "lucide-react";
import {
  onInstallAvailability,
  onOnline,
  promptInstall,
  isStandalone,
} from "../pwa";
import { shouldShowPwaPrompt } from "./pwaDismissal";

/**
 * Two banner-style PWA UI bits (Theme C · Ink & Petrol):
 *   • Install prompt — surfaces when the browser fires beforeinstallprompt
 *     and the app isn't already installed. Dismissed state persists in
 *     localStorage so we don't nag (7-day cool-off).
 *   • Offline pill — appears when navigator goes offline.
 *
 * Mounted once at the app root, renders nothing the rest of the time.
 * Visual only — install/dismiss/standalone logic is unchanged.
 */

const DISMISS_KEY = "pwa:install:dismissed-at";
const NAG_AFTER_DAYS = 7;

export function PwaBanners() {
  const installBranding = useBranding();
  const [canInstall, setCanInstall] = useState(false);
  const [online, setOnline] = useState(true);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => onInstallAvailability(setCanInstall), []);
  useEffect(() => onOnline(setOnline), []);

  useEffect(() => {
    if (!canInstall || isStandalone()) {
      setShowInstall(false);
      return;
    }
    try {
      setShowInstall(shouldShowPwaPrompt(DISMISS_KEY, NAG_AFTER_DAYS));
    } catch {
      setShowInstall(true);
    }
  }, [canInstall]);

  function dismissInstall() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setShowInstall(false);
  }

  async function install() {
    const outcome = await promptInstall();
    if (outcome !== "unavailable") setShowInstall(false);
  }

  return (
    <>
      {!online && (
        <div
          className="fixed left-1/2 top-3 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning-text/40 bg-warning-bg px-3 py-1.5 text-[11px] font-semibold text-warning-text shadow-lg"
          role="status"
          aria-live="polite"
        >
          <WifiOff size={12} />
          You're offline — showing cached data
        </div>
      )}

      {/* The new-build banner that lived here was REMOVED (owner 2026-07-31:
          "why got 2 button refresh?") — NewVersionBanner.tsx already shows the
          bottom "A newer version is ready · Refresh now" toast, so this
          top-centre pill was a duplicate prompt for the same event. */}

      {showInstall && (
        <div className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-md rounded-2xl border border-border bg-surface px-[18px] py-4 shadow-slab sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[340px]">
          <div className="flex items-start gap-3">
            {/* Brand mark — Houzs Century HC logo on a dark ink slab. The
                brightness-0+invert filter pair flattens the black PNG to a
                pure-white silhouette, matching the sidebar's logo treatment
                (see Sidebar.tsx LOGO_MARK_SRC usage). */}
            <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-ink p-2">
              <CompanyMark
                variant="mark"
                imgClassName="h-full w-full object-contain brightness-0 invert"
                uploadedImgClassName="h-full w-full object-contain"
                textClassName="text-[13px] font-bold text-white"
              />
            </div>
            <div className="flex-1">
              <div className="text-[13.5px] font-bold text-ink">
                Install {shortCompanyName(installBranding.companyName)} · ERP
              </div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                Add it to your home screen — opens in one tap, runs like a native app, and works even on a weak connection.
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={install}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[11.5px] font-bold text-white hover:bg-primary-ink"
                >
                  <Download size={14} strokeWidth={2} />
                  Install
                </button>
                <button
                  onClick={dismissInstall}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-[11.5px] font-semibold text-ink-secondary hover:text-ink"
                >
                  Not now
                </button>
              </div>
            </div>
            <button
              onClick={dismissInstall}
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
