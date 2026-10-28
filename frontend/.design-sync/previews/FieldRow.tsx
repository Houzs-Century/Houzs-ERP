import { FieldRow, PanelSection, Badge } from "autocount-sync-frontend";

// Baseline label/value row for Panel bodies — uppercase micro label on the
// left, right-aligned wrapping value. `mono` switches the value to Plex Mono
// for doc numbers, amounts and timestamps.

export const Canonical = () => (
  <div className="w-72 space-y-2.5">
    <FieldRow label="Customer">Akemi Furniture Sdn Bhd</FieldRow>
    <FieldRow label="Salesperson">Farra Aziz</FieldRow>
    <FieldRow label="Outlet">Setia Alam Showroom</FieldRow>
  </div>
);

export const MonoValues = () => (
  <div className="w-72 space-y-2.5">
    <FieldRow label="SO no" mono>SO-2990-0417</FieldRow>
    <FieldRow label="DO ref" mono>DO-01842</FieldRow>
    <FieldRow label="Total" mono>RM 18,540.00</FieldRow>
    <FieldRow label="Synced at" mono>2026-06-13 09:41</FieldRow>
  </div>
);

export const RichValues = () => (
  <div className="w-72 space-y-2.5">
    <FieldRow label="Sync"><Badge tone="success">Synced</Badge></FieldRow>
    <FieldRow label="SLA"><Badge tone="error">2 days over</Badge></FieldRow>
    <FieldRow label="Address">
      12 Jalan Puteri 7/13, Bandar Puteri, 47100 Puchong, Selangor
    </FieldRow>
  </div>
);

export const InsidePanelSection = () => (
  <div className="w-80">
    <PanelSection title="Service case">
      <FieldRow label="Case no" mono>ASSR-0231</FieldRow>
      <FieldRow label="Customer">Tan Wei Ming</FieldRow>
      <FieldRow label="Technician">Hafiz Rahman</FieldRow>
      <FieldRow label="Status"><Badge tone="warning">Awaiting parts</Badge></FieldRow>
    </PanelSection>
  </div>
);
