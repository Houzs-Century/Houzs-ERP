import { DefinitionList, Section, Badge } from "autocount-sync-frontend";

// Responsive 2-column label/value grid for detail pages — denser than
// stacked FieldRows. Empty values are filtered out; `full` spans both
// columns; `mono` for doc numbers and timestamps.

export const Canonical = () => (
  <div className="w-[480px]">
    <DefinitionList
      items={[
        { label: "SO no", value: "SO-2990-0417", mono: true },
        { label: "Customer", value: "Akemi Furniture Sdn Bhd" },
        { label: "Salesperson", value: "Farra Aziz" },
        { label: "Confirmed", value: "12 Jun 2026" },
      ]}
    />
  </div>
);

export const FullSpanAndMono = () => (
  <div className="w-[480px]">
    <DefinitionList
      items={[
        { label: "DO no", value: "DO-01842", mono: true },
        { label: "Driver", value: "Azlan Musa" },
        {
          label: "Address",
          value: "12 Jalan Puteri 7/13, Bandar Puteri, 47100 Puchong, Selangor",
          full: true,
        },
        { label: "Synced", value: "2026-06-13 09:41", mono: true },
        { label: "Status", value: <Badge tone="success">Synced</Badge> },
      ]}
    />
  </div>
);

export const EmptyValuesFallback = () => (
  <div className="w-[480px]">
    {/* Every value empty → the list renders a single dash placeholder. */}
    <DefinitionList
      items={[
        { label: "Warranty ref", value: "" },
        { label: "Serial no", value: null },
        { label: "Return DO", value: undefined },
      ]}
    />
  </div>
);

export const InsideSection = () => (
  <div className="w-[480px]">
    <Section title="Case info">
      <DefinitionList
        items={[
          { label: "Case no", value: "ASSR-0231", mono: true },
          { label: "Customer", value: "Tan Wei Ming" },
          { label: "Technician", value: "Hafiz Rahman" },
          { label: "SLA", value: <Badge tone="error">2 days over</Badge> },
        ]}
      />
    </Section>
  </div>
);
