import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Mail, MapPin, ShieldCheck } from "lucide-react";

// Customer-facing portal shell. Designed to feel like a considered,
// well-made document rather than a generic SaaS layout — this is a
// furniture retailer, not a tech product, so the tone is warm,
// traditional, solid. Responsive with deliberate differences between
// phone and desktop:
//
//   Mobile (≤640px): compact header (logo only), generous tap targets
//     in the footer, stacked 1-col layout, visible section dividers.
//   Tablet+ (640px+): header carries a small tagline flourish.
//   Desktop (1024px+): 3-col footer with breathing room, inline
//     bottom strip.

const LOGO_WORDMARK = "/logo-wordmark.png";

export function PortalFrame({ children }: { children: ReactNode }) {
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      {/* ═══ Top bar ═══════════════════════════════════════
          Compact on mobile (logo only), a small brand flourish
          appears on sm+ so the header doesn't feel empty on
          larger screens. The gradient hairline below catches
          the warm accent tone without adding visual weight. */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            to="/track"
            className="flex items-center gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 rounded"
            aria-label="Houzs Century — service case tracking"
          >
            <img
              src={LOGO_WORDMARK}
              alt="Houzs Century"
              className="h-8 w-auto max-w-[140px] object-contain sm:h-10 sm:max-w-[180px]"
              draggable={false}
            />
          </Link>

          {/* Desktop tagline with decorative hairline */}
          <div className="hidden items-center gap-3 text-[10px] font-semibold uppercase tracking-[3pt] text-accent sm:flex">
            <span className="h-px w-8 bg-accent/40" />
            Service Case Tracking
          </div>
        </div>
        {/* Warm hairline accent underneath */}
        <div className="h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
      </header>

      {/* ═══ Main content ═══════════════════════════════════
          `print-area` is the app's print opt-in (index.css): the global
          `body * { visibility: hidden }` means an un-tagged page prints a
          BLANK sheet, which is exactly what the supplier case's Print button
          did. Tagging the frame's main covers every portal page at once —
          the header / footer chrome stays off the paper, which is what you
          want there anyway. */}
      <main className="print-area mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>

      {/* ═══ Footer ═════════════════════════════════════════
          Three loosely-defined columns on desktop, stacked on
          mobile with a visible divider between each section.
          Email is a real mailto: anchor so
          mobile users can tap straight through. */}
      <footer className="border-t border-border bg-surface">
        {/* Decorative opener — tiny "mark" glyph centered above the content */}
        <div className="flex items-center justify-center pt-7">
          <div className="flex items-center gap-3 text-accent/60">
            <span className="h-px w-8 bg-current" />
            <span className="font-display text-[10px] font-bold uppercase tracking-[4pt]">
              Houzs Century
            </span>
            <span className="h-px w-8 bg-current" />
          </div>
        </div>

        <div className="mx-auto max-w-5xl px-4 pb-8 pt-6 sm:px-6 sm:pb-10">
          <div className="grid gap-6 divide-y divide-border sm:grid-cols-2 sm:gap-8 sm:divide-y-0 lg:grid-cols-3">
            {/* ── Company identity ───────────────────────── */}
            <section className="pt-0">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2pt] text-ink-muted">
                Company
              </div>
              <div className="font-display text-[14px] font-extrabold uppercase leading-tight tracking-wide text-ink">
                Houzs Century Sdn. Bhd.
              </div>
              <div className="mt-1 font-mono text-[11px] tracking-tight text-ink-muted">
                202201031135&nbsp;&middot;&nbsp;(1476832-W)
              </div>
              <div className="mt-4 flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-secondary">
                <MapPin size={13} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
                <address className="not-italic">
                  1831-B, Jalan KPB 1,<br />
                  Kawasan Perindustrian Balakong,<br />
                  43300 Seri Kembangan, Selangor.
                </address>
              </div>
            </section>

            {/* ── Contact ────────────────────────────────── */}
            <section className="pt-6 sm:pt-0">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2pt] text-ink-muted">
                Get in touch
              </div>
              <ul className="space-y-2.5 text-[12.5px] text-ink-secondary">
                {/* Phone removed (Nick 2026-07-06) — email is the service
                    desk's contact channel. */}
                <li>
                  <a
                    href="mailto:operation_service@houzscentury.com"
                    className="inline-flex items-center gap-2.5 py-1 transition-colors hover:text-accent"
                  >
                    <Mail size={13} className="shrink-0 text-ink-muted" aria-hidden />
                    <span className="font-medium">operation_service@houzscentury.com</span>
                  </a>
                </li>
              </ul>
              <div className="mt-4 border-l-2 border-accent/30 pl-3 text-[11.5px] leading-relaxed text-ink-muted">
                <div className="text-[10px] font-semibold uppercase tracking-[1.5pt] text-ink-secondary">
                  Operating Hours
                </div>
                Mon – Sat&nbsp;&middot;&nbsp;9:00 AM – 6:00 PM<br />
                Closed Sundays &amp; public holidays
              </div>
            </section>

            {/* ── Privacy & data ─────────────────────────── */}
            <section className="pt-6 sm:col-span-2 sm:pt-6 lg:col-span-1 lg:pt-0">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[2pt] text-ink-muted">
                <ShieldCheck size={11} className="text-accent" aria-hidden />
                Privacy &amp; Security
              </div>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                Your case information is viewable only with your case
                number and the phone number on file. We don't use
                passwords or long-lived sessions — tracking links expire
                automatically.
              </p>
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-muted">
                Personal data is handled in accordance with the{" "}
                <span className="font-semibold text-ink-secondary">
                  Personal Data Protection Act 2010
                </span>{" "}
                (Malaysia). We do not share customer information with
                third parties except service-chain suppliers explicitly
                engaged for your repair.
              </p>
            </section>
          </div>

          {/* Bottom strip — inline on sm+, stacked on xs */}
          <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t border-border pt-5 text-[10.5px] text-ink-muted sm:flex-row sm:gap-4">
            <div className="order-2 sm:order-1">
              &copy; {year} Houzs Century Sdn. Bhd. All rights reserved.
            </div>
            <div className="order-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 sm:order-2 sm:justify-end">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent/60" />
                SSM-registered
              </span>
              <span className="hidden h-3 w-px bg-border sm:inline-block" />
              <span>Furniture · Retail · Service</span>
              <span className="hidden h-3 w-px bg-border sm:inline-block" />
              <span className="font-mono tracking-tight">v1.0</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
