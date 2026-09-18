// The ONLY place the phone and the desktop SO filter controls differ: class
// names. The phone draws with mobile.css (`.hz-m` scope), the desktop with the
// Tailwind tokens the SO list page already uses. Behaviour is shared.
export type SoFilterSkin = "mobile" | "desktop";

export interface SoFilterSkinClasses {
  input: string;
  label: string;
  chip: (on: boolean) => string;
  option: (on: boolean) => string;
  ghostButton: string;
  primaryButton: string;
  muted: string;
}

export const SO_FILTER_SKINS: Record<SoFilterSkin, SoFilterSkinClasses> = {
  mobile: {
    input: "fld-i",
    label: "fld-l",
    chip: (on) => (on ? "chip on" : "chip"),
    option: () => "mcard",
    ghostButton: "btn-ghost",
    primaryButton: "btn",
    muted: "list-note",
  },
  desktop: {
    input:
      "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20",
    label: "text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted",
    chip: (on) =>
      on
        ? "rounded-full border border-primary bg-primary-soft px-3 py-1 text-[12px] font-semibold text-primary"
        : "rounded-full border border-border bg-surface px-3 py-1 text-[12px] font-medium text-ink-secondary hover:border-primary/60",
    option: (on) =>
      on
        ? "flex w-full items-center justify-between rounded-md border border-primary bg-primary-soft px-3 py-2 text-left text-[13px] font-semibold text-primary"
        : "flex w-full items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-primary/60",
    ghostButton:
      "inline-flex h-9 items-center justify-center rounded-md border border-border bg-surface px-4 text-[13px] font-semibold text-ink-secondary hover:border-primary/60",
    primaryButton:
      "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-[13px] font-semibold text-white hover:bg-primary/90 disabled:opacity-60",
    muted: "text-[12px] text-ink-muted",
  },
};
