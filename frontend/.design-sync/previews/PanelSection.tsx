import { PanelSection, FieldRow, Badge } from "autocount-sync-frontend";
import { Truck, Wrench } from "lucide-react";

// Card slab used inside the Panel slide-over body — uppercase header,
// optional icon / top-right action / left accent strip / muted background.

export const Canonical = () => (
  <div className="w-80">
    <PanelSection title="Order">
      <FieldRow label="Customer">Akemi Furniture Sdn Bhd</FieldRow>
      <FieldRow label="Doc no" mono>SO-2990-0417</FieldRow>
      <FieldRow label="Total" mono>RM 18,540.00</FieldRow>
    </PanelSection>
  </div>
);

export const IconAndAction = () => (
  <div className="w-80">
    <PanelSection
      title="Delivery"
      icon={<Truck size={13} />}
      action={<Badge tone="warning">Partial</Badge>}
    >
      <FieldRow label="DO ref" mono>DO-01842</FieldRow>
      <FieldRow label="Scheduled">18 Jun 2026, AM slot</FieldRow>
    </PanelSection>
  </div>
);

export const MutedAndAccent = () => (
  <div className="w-80 space-y-0">
    <PanelSection title="AutoCount" muted>
      <FieldRow label="Sync state"><Badge tone="success">Synced</Badge></FieldRow>
      <FieldRow label="Last push" mono>2026-06-13 09:41</FieldRow>
    </PanelSection>
    <PanelSection title="Escalation" accent="bg-err" icon={<Wrench size={13} />}>
      <FieldRow label="Case" mono>ASSR-0231</FieldRow>
      <FieldRow label="SLA"><Badge tone="error">2 days over</Badge></FieldRow>
    </PanelSection>
  </div>
);

export const PanelBodyStack = () => (
  <div className="w-80 rounded-lg bg-bg p-3">
    <PanelSection title="Customer">
      <FieldRow label="Name">Tan Wei Ming</FieldRow>
      <FieldRow label="Phone" mono>+60 12-338 4471</FieldRow>
    </PanelSection>
    <PanelSection title="Assignment" accent="bg-accent">
      <FieldRow label="Technician">Hafiz Rahman</FieldRow>
      <FieldRow label="Visit">05 Jul 2026, PM slot</FieldRow>
    </PanelSection>
    <PanelSection title="Notes" muted>
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        Recliner mechanism jams halfway; customer asked for a morning call
        before dispatch.
      </p>
    </PanelSection>
  </div>
);
