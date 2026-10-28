import { DashboardPanels, DashboardBreakdown } from "autocount-sync-frontend";

// Container row for breakdown panels under the stat strip — single column
// below lg, steps up to 2 or 3 columns at lg+. Children are
// DashboardBreakdown panels (or anything panel-shaped).

export const TwoPanels = () => (
  <div className="w-[52rem]">
    <DashboardPanels cols={2}>
      <DashboardBreakdown
        title="Sales Orders by Region"
        items={[
          { label: "Klang Valley", count: 214 },
          { label: "Penang", count: 96 },
          { label: "Johor", count: 71 },
          { label: "Perak", count: 38 },
        ]}
      />
      <DashboardBreakdown
        title="Service Cases by SLA Health"
        items={[
          { label: "On track", count: 64, tone: "success" },
          { label: "Approaching SLA", count: 18, tone: "warn" },
          { label: "Breached", count: 5, tone: "error" },
        ]}
      />
    </DashboardPanels>
  </div>
);

export const ThreePanels = () => (
  <div className="w-[56rem]">
    <DashboardPanels cols={3}>
      <DashboardBreakdown
        title="Top Products"
        items={[
          { label: "Panasonic 2.5HP Inverter", count: 48 },
          { label: "Daikin 1.0HP Wall-Mounted", count: 36 },
          { label: "L-Shape Sofa (Fabric)", count: 21 },
        ]}
      />
      <DashboardBreakdown
        title="Top Technicians"
        items={[
          { label: "Hafiz Rahman", count: 31, tone: "success" },
          { label: "Kumar Selvam", count: 27, tone: "success" },
          { label: "Chong Kah Wai", count: 19 },
        ]}
      />
      <DashboardBreakdown
        title="PO Spend by Supplier"
        items={[
          { label: "Panasonic Malaysia", count: 182400 },
          { label: "Daikin Distribution", count: 96100 },
          { label: "Fella Design", count: 44800 },
        ]}
        formatCount={(n) => `RM ${(n / 1000).toFixed(0)}k`}
      />
    </DashboardPanels>
  </div>
);
