import {
  shippedProgressOf,
  shippedProgressOfLine,
  shippedProgressLabel,
  type ShippedProgressFields,
  type ShippedProgressLineFields,
} from "../vendor/scm/lib/shipped-progress";

const TONE = {
  none: "bg-surface-dim text-ink-muted",
  partial: "bg-warning-bg text-warning-text",
  full: "bg-synced-bg text-synced",
} as const;

const TITLE = {
  none: "Nothing has been delivered on this order yet.",
  partial: "Partly delivered — the number still owed is the difference.",
  full: "Fully delivered — every committed unit has left.",
} as const;

export function ShippedProgressPill(
  props: { row: ShippedProgressFields; line?: never } | { line: ShippedProgressLineFields; row?: never },
) {
  const p = props.row !== undefined ? shippedProgressOf(props.row) : shippedProgressOfLine(props.line);
  /* An older payload carries neither field. Say so rather than printing "0 / 0",
     which reads as "nothing shipped" — the same lie coverage-state.tsx exists to
     stop (docs/modules/coverage-state.md). */
  if (p.state === "unknown") {
    return <span className="text-[11px] text-ink-muted" title="This list has not sent the delivered figures.">—</span>;
  }
  const label = shippedProgressLabel(p);
  return (
    <span
      title={TITLE[p.state]}
      className={
        "inline-block rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider tabular-nums " +
        TONE[p.state]
      }
    >
      {label}
    </span>
  );
}
