import { useEffect, useState, type CSSProperties } from "react";
import { useBranding } from "../hooks/useBranding";
import { api } from "../api/client";
import { HOUZS_COMPANY_CODE, shortCompanyName } from "../lib/branding";

// ── Company brand mark (multi-company chrome) ────────────────
//
// The app chrome used to hardcode the bundled Houzs wordmark/mark PNGs.
// Those assets are HOUZS-only — they must never brand another company's
// session. This component keeps HOUZS byte-identical (same bundled asset,
// same classes) and for any other active company renders, in order:
//   1. the company's uploaded logo (Settings → Branding), fetched as an
//      authed blob URL (the serve endpoint needs the bearer, same pattern
//      as Settings' preview and Avatar);
//   2. a text lockup with the company's short name — pre-auth (login screen,
//      where the logo endpoint 401s) and pre-upload this is what shows.
//
// The active company comes from useBranding() (backend echo → hostname
// default), so the mark flips with the top-bar company switcher.

const HOUZS_ASSETS: Record<"wordmark" | "mark", string> = {
  wordmark: "/logo-wordmark.png",
  mark: "/logo-mark.png",
};

interface CompanyMarkProps {
  /** wordmark = horizontal lockup (top bars, expanded sidebar);
   *  mark = square glyph (collapsed sidebar). */
  variant: "wordmark" | "mark";
  /** Classes applied to the <img> (bundled asset or uploaded logo). */
  imgClassName?: string;
  /** Classes for a non-HOUZS company's UPLOADED logo, when the bundled-asset
   *  treatment doesn't suit it (e.g. the sidebar's `brightness-0 invert`
   *  whitewash would blank out a colour logo). Falls back to imgClassName. */
  uploadedImgClassName?: string;
  /** Inline style for the <img> (e.g. the auth screen's invert filter). */
  imgStyle?: CSSProperties;
  /** Classes for the text fallback when a non-HOUZS company has no logo. */
  textClassName?: string;
}

/** Two-character glyph for the square mark fallback: first character of the
 *  first two words ("2990's Home" → "2H"), or the first two characters of a
 *  single-word name. */
function markGlyph(name: string): string {
  const words = shortCompanyName(name).split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

export function CompanyMark({
  variant,
  imgClassName,
  uploadedImgClassName,
  imgStyle,
  textClassName,
}: CompanyMarkProps) {
  const branding = useBranding();
  const isHouzs = branding.companyCode === HOUZS_COMPANY_CODE;

  // Uploaded-logo blob URL for non-HOUZS companies. Keys carry a Date.now()
  // stamp (new upload = new key), so keying the effect on logoR2Key both
  // busts stale previews and avoids refetching on unrelated re-renders.
  const logoKey = !isHouzs ? branding.logoR2Key : "";
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!logoKey) {
      setLogoUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    api
      .fetchBlobUrl(`/api/branding/logo?k=${encodeURIComponent(logoKey)}`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          url = u;
          setLogoUrl(u);
        }
      })
      .catch(() => setLogoUrl(null)); // fail-soft → text lockup
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [logoKey]);

  const src = isHouzs ? HOUZS_ASSETS[variant] : logoUrl;
  if (src) {
    return (
      <img
        src={src}
        alt={branding.companyName}
        className={isHouzs ? imgClassName : uploadedImgClassName ?? imgClassName}
        style={isHouzs ? imgStyle : undefined}
        draggable={false}
      />
    );
  }
  return (
    <span className={textClassName} title={branding.companyName}>
      {variant === "mark"
        ? markGlyph(branding.companyName)
        : shortCompanyName(branding.companyName)}
    </span>
  );
}
