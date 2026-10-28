import { Badge, Button, ResizableDrawer } from "autocount-sync-frontend";

// Right-side slide-over with a DRAGGABLE left edge (width persists per
// storageKey). Chrome only — dark 60px header, scroll body, sticky footer.
// First consumer is the Delivery Planning ScheduleTripDrawer; the body here
// mirrors that shape with plain DS classes. Fixed-position overlay, so the
// card runs cardMode single with its own viewport.

try {
  localStorage.removeItem("ds-preview-schedule-drawer");
} catch {
  /* private mode */
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {label}
    </div>
    <div className="mt-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">
      {value}
    </div>
  </div>
);

export const ScheduleTrip = () => (
  <>
    {/* In-app the aside's h-full = viewport height; in the card-capture
        wrapper % height collapses AND the drawer's flex-1 overflow body
        clamps to 0 (min-height:auto → 0). Pin the aside to the card height
        so the capture shows what the operator actually sees. */}
    <style>{`aside[aria-label="Schedule delivery trip"]{height:600px}`}</style>
    <ResizableDrawer
    onClose={() => {}}
    title="Schedule Delivery Trip"
    subtitle="DO-2990-0233 · KL/SEL · Thu 2026-08-02"
    headerActions={<Badge tone="warning">Unassigned</Badge>}
    storageKey="ds-preview-schedule-drawer"
    defaultWidth={560}
    ariaLabel="Schedule delivery trip"
    footer={
      <div className="flex justify-end gap-2">
        <Button variant="secondary">Cancel</Button>
        <Button variant="primary">Save Trip</Button>
      </div>
    }
  >
    {/* Explicit height: the aside's own h-full can't resolve inside the
        card-capture wrapper (transformed ancestor → % height collapses), so
        the body content carries the height that makes the drawer read whole. */}
    <div className="h-[500px] space-y-4 p-5">
      <Field label="Driver" value="Wei Jian" />
      <Field label="Lorry" value="WXY 8123 — 3-ton box" />
      <Field label="Crew" value="Aiman + Hafiz" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Window from" value="09:30" />
        <Field label="Window to" value="12:00" />
      </div>
      <div>
        <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Stops
        </div>
        <div className="mt-1 space-y-2">
          {[
            ["1", "Sunway Geo Residences — Tower B", "2 × Luna 3-Seater"],
            ["2", "Kiara Designer Suites", "Aurora Dining 200cm"],
          ].map(([n, place, load]) => (
            <div
              key={n}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2 shadow-stone"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-[10px] font-bold text-primary-ink">
                {n}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink">{place}</div>
                <div className="text-[11px] text-ink-muted">{load}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </ResizableDrawer>
  </>
);
