import {
  AlertTriangle,
  BookOpen,
  Megaphone,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

// ────────────────────────────────────────────────────────────────────────────
// announcementCategory — the ONE definition of what a notice category looks
// like and whether it blocks. Read by the mandatory modal (AnnouncementBanner),
// the pop-up hook, the Announcements page (Inbox / Manage / composer), the
// dashboard stack and the notification panel, so a colour or a CTA label can
// never differ between two of them.
//
// Colours are unchanged from the 2026-07-09 banner redesign: Notice=petrol,
// Warning=err, SOP=brass, Learning=trend blue. Brass stays brand-only
// elsewhere; the SOP acknowledge button is the one sanctioned exception and it
// is inherited from that banner, not invented by the 2026-09-04 redesign.
// All classes are static literals — Tailwind's content scan can't see
// runtime-composed names, so never build them.
// ────────────────────────────────────────────────────────────────────────────

export type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

export type CategoryMeta = {
  label: string;
  Icon: LucideIcon;
  /** Tinted pill: `bg-* text-*`. */
  pillCls: string;
  /** Solid rail / bar colour. */
  railCls: string;
  /** Solid primary CTA. */
  solidCls: string;
  /** Bordered card outline for the mandatory modal / dashboard banner. */
  borderCls: string;
  /** Eyebrow text colour. */
  textCls: string;
  /** Icon chip on the modal and the dashboard banner. */
  chipCls: string;
  ctaLabel: string;
};

export const CATEGORY_META: Record<AnnouncementCategory, CategoryMeta> = {
  GENERAL: {
    label: "Notice",
    Icon: Megaphone,
    pillCls: "bg-primary-soft text-primary-ink",
    railCls: "bg-primary",
    solidCls: "bg-primary text-white hover:bg-primary/90",
    borderCls: "border-primary",
    textCls: "text-primary",
    chipCls: "bg-primary-soft text-primary",
    ctaLabel: "Got it",
  },
  WARNING: {
    label: "Warning",
    Icon: AlertTriangle,
    pillCls: "bg-err-bg text-err",
    railCls: "bg-err",
    solidCls: "bg-err text-white hover:bg-err/90",
    borderCls: "border-err",
    textCls: "text-err",
    chipCls: "bg-err-bg text-err",
    ctaLabel: "Got it",
  },
  SOP: {
    label: "SOP",
    Icon: ShieldCheck,
    pillCls: "bg-accent-soft text-accent",
    railCls: "bg-accent",
    solidCls: "bg-accent text-white hover:bg-accent/90",
    borderCls: "border-accent",
    textCls: "text-accent",
    chipCls: "bg-accent-soft text-accent",
    ctaLabel: "Acknowledge",
  },
  LEARNING: {
    label: "Learning",
    Icon: BookOpen,
    pillCls: "bg-learning text-white",
    railCls: "bg-learning",
    solidCls: "bg-learning text-white hover:bg-learning/90",
    borderCls: "border-learning",
    textCls: "text-learning",
    chipCls: "bg-learning/15 text-learning",
    ctaLabel: "Watch",
  },
};

/** Composer / filter order — the two blocking categories first. */
export const CATEGORY_ORDER: AnnouncementCategory[] = [
  "WARNING",
  "SOP",
  "LEARNING",
  "GENERAL",
];

export function readCategory(v: unknown): AnnouncementCategory {
  return v === "WARNING" || v === "SOP" || v === "LEARNING" ? v : "GENERAL";
}

export function categoryOf(a: { category?: AnnouncementCategory | null }): AnnouncementCategory {
  return a.category ?? "GENERAL";
}

/** Categories that block by default. GENERAL and LEARNING never block — they
 *  are acknowledged inline in the list, never through the modal. */
export function categoryRequiresAck(category: AnnouncementCategory): boolean {
  return category === "WARNING" || category === "SOP";
}

/** Does this notice demand an acknowledgement? The per-notice flag wins when
 *  the backend sends it; until then (and for every legacy row) the category
 *  rule stands in. Applies everywhere: the modal, the pinned inbox group, the
 *  dashboard stack and the notification panel all key off this one answer. */
export function requiresAcknowledgement(a: {
  category?: AnnouncementCategory | null;
  requireAck?: boolean | null;
}): boolean {
  if (typeof a.requireAck === "boolean") return a.requireAck;
  return categoryRequiresAck(categoryOf(a));
}
