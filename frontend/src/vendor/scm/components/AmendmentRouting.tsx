// ----------------------------------------------------------------------------
// AmendmentRouting — presentational chips for the amendment TYPE badges and the
// per-row / grouped DEPARTMENT routing. Tailwind-styled, shared by the three
// desktop + shared-surface amendment views (AmendmentDetailV2, PoAmendmentDetailV2,
// the SalesOrderDetail diff modal). The two mobile surfaces render the same data
// with their own inline-style idiom — the SHARED part is the classification
// (amendment-routing.ts), not the pixels.
//
// Advisory only: this shows WHO is responsible for WHAT. It never changes the
// single-signature apply gate. No emoji (owner rule).
// ----------------------------------------------------------------------------

import {
  routeField,
  summariseRouting,
  FIELD_KIND_LABEL,
  TYPE_LABEL,
  TYPE_RESPONSIBLE,
  type AmendmentFieldKind,
  type AmendmentType,
} from '../lib/amendment-routing';

/* Muted, theme-token tints per type so the badge reads as a quiet label, not a
   status alarm. Processing = brand accent; Delivery/Commercial = a warm/info tone. */
const TYPE_CHIP: Record<AmendmentType, string> = {
  PROCESSING: 'border-primary/30 bg-primary/10 text-primary-ink',
  DELIVERY_COMMERCIAL: 'border-accent-bright/30 bg-accent-bright/10 text-ink',
};

/** The type badge(s) for a set of changed atoms. A MIXED amendment shows both,
    with a leading "Mixed" marker so the reader knows it spans responsibilities. */
export function AmendmentTypeBadges({
  kinds,
  className,
}: {
  kinds: AmendmentFieldKind[];
  className?: string;
}) {
  const { types, isMixed } = summariseRouting(kinds);
  if (types.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {isMixed && (
        <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          Mixed
        </span>
      )}
      {types.map((t) => (
        <span
          key={t}
          title={`Responsible: ${TYPE_RESPONSIBLE[t]}`}
          className={`rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand ${TYPE_CHIP[t]}`}
        >
          {TYPE_LABEL[t]}
        </span>
      ))}
    </div>
  );
}

/** Per-row department chips: for ONE changed diff row, the responsible department
    against each atom it moves. Renders nothing for a row with no routable change. */
export function RowRoutingChips({ kinds }: { kinds: AmendmentFieldKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {kinds.map((k) => {
        const r = routeField(k);
        return (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-secondary"
          >
            <span className="font-medium text-ink">{FIELD_KIND_LABEL[k]}</span>
            <span className="text-ink-muted">&rarr;</span>
            <span className="font-semibold text-primary-ink">{r.department}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The grouped routing block: each responsible department against the fields it
    owns across the WHOLE amendment. Mirrors the PDF routing block; used in the
    detail aside so an approver sees the accountability map at a glance. */
export function AmendmentRoutingBlock({ kinds }: { kinds: AmendmentFieldKind[] }) {
  const { departments } = summariseRouting(kinds);
  if (departments.length === 0) return null;
  return (
    <div className="space-y-2">
      {departments.map(({ department, kinds: deptKinds }) => (
        <div key={department} className="flex items-start justify-between gap-3 text-[12px]">
          <span className="font-semibold text-ink">{department}</span>
          <span className="text-right text-ink-secondary">
            {deptKinds.map((k) => FIELD_KIND_LABEL[k]).join(', ')}
          </span>
        </div>
      ))}
    </div>
  );
}
