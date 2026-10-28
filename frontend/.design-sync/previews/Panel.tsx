import { Panel, PanelSection, FieldRow, Badge, Button } from "autocount-sync-frontend";

// Right-side document slide-over (portal, fixed to the viewport right edge).
// The canonical "peek at a document" surface — SO/DO/service-case quick view
// with PanelSection slabs inside and an action footer.

export const SalesOrderDocument = () => (
  <Panel
    open
    onClose={() => {}}
    title="SO-2990-0417"
    subtitle="Akemi Furniture Sdn Bhd · confirmed 12 Jun 2026"
    footer={
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost">Print</Button>
        <Button variant="primary">Open full page</Button>
      </div>
    }
  >
    <PanelSection title="Order">
      <FieldRow label="Customer">Akemi Furniture Sdn Bhd</FieldRow>
      <FieldRow label="Salesperson">Farra Aziz</FieldRow>
      <FieldRow label="Doc no" mono>SO-2990-0417</FieldRow>
      <FieldRow label="Total" mono>RM 18,540.00</FieldRow>
      <FieldRow label="Status"><Badge tone="success">Synced</Badge></FieldRow>
    </PanelSection>
    <PanelSection title="Delivery" muted>
      <FieldRow label="DO ref" mono>DO-01842</FieldRow>
      <FieldRow label="Scheduled">18 Jun 2026, AM slot</FieldRow>
      <FieldRow label="Address">12 Jalan Puteri 7/13, Bandar Puteri, 47100 Puchong</FieldRow>
    </PanelSection>
  </Panel>
);

export const CompactWidth = () => (
  <Panel
    open
    onClose={() => {}}
    width={360}
    title="ASSR-0231"
    subtitle="Recliner mechanism jam · reported 02 Jul 2026"
  >
    <PanelSection title="Service case" accent="bg-err">
      <FieldRow label="Customer">Tan Wei Ming</FieldRow>
      <FieldRow label="Technician">Hafiz Rahman</FieldRow>
      <FieldRow label="SLA"><Badge tone="error">2 days over</Badge></FieldRow>
    </PanelSection>
  </Panel>
);
