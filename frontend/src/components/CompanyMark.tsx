import { useEffect, useState, type CSSProperties } from "react";
import { useBranding } from "../hooks/useBranding";
import { api } from "../api/client";
import { HOUZS_COMPANY_CODE, shortCompanyName } from "../lib/branding";


const HOUZS_ASSETS: Record<"wordmark" | "mark", string> = {
  wordmark: "/logo-wordmark.png",
  mark: "/logo-mark.png",
};

interface CompanyMarkProps {
  variant: "wordmark" | "mark";
  imgClassName?: string;
  uploadedImgClassName?: string;
  imgStyle?: CSSProperties;
  textClassName?: string;
}

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
      .catch(() => setLogoUrl(null));
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
