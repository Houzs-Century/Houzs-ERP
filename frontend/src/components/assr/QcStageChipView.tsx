import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { qcStageChip } from "../../vendor/scm/lib/assr/item-ready";

const TONE_CLASS = {
  ok: "bg-synced/15 text-synced",
  warn: "bg-accent-soft/60 text-accent",
  muted: "bg-bg text-ink-muted",
} as const;

export function QcStageChipView({ value }: { value: string | null | undefined }): ReactElement | null {
  const chip = qcStageChip(value);
  if (!chip) return null;
  return (
    <span className={cn("rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider", TONE_CLASS[chip.tone])}>
      {chip.label}
    </span>
  );
}
