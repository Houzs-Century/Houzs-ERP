import { useState } from "react";
import { DashboardBreakdown } from "autocount-sync-frontend";

// Distribution panel — label + count + proportional bar per row. Used for
// "by region", "by status", "top suppliers" under the stat strip. Rows
// become drill-down buttons when onItemClick is set.

export const ByRegion = () => (
  <div className="w-80">
    <DashboardBreakdown
      title="Deliveries by Region"
      items={[
        { label: "Klang Valley", count: 214 },
        { label: "Penang", count: 96 },
        { label: "Johor", count: 71 },
        { label: "Perak", count: 38 },
        { label: "East Malaysia", count: 12 },
      ]}
    />
  </div>
);

export const SlaHealthTones = () => (
  <div className="w-80">
    <DashboardBreakdown
      title="ASSR Cases by SLA Health"
      items={[
        { label: "Completed", count: 148, tone: "success" },
        { label: "On track", count: 64, tone: "success" },
        { label: "Approaching SLA", count: 18, tone: "warn" },
        { label: "Breached", count: 5, tone: "error" },
      ]}
    />
  </div>
);

export const DrilldownActive = () => {
  const [active, setActive] = useState("Klang Valley");
  return (
    <div className="w-80">
      <DashboardBreakdown
        title="Filter Orders by Region"
        items={[
          { label: "Klang Valley", count: 214 },
          { label: "Penang", count: 96 },
          { label: "Johor", count: 71 },
        ]}
        onItemClick={setActive}
        activeLabel={active}
      />
    </div>
  );
};

export const MoneyFormat = () => (
  <div className="w-80">
    <DashboardBreakdown
      title="Revenue by Product Category"
      items={[
        { label: "Air Conditioning", count: 412800 },
        { label: "Living Room Furniture", count: 268400 },
        { label: "Dining Sets", count: 121500 },
        { label: "Appliances", count: 58200 },
      ]}
      formatCount={(n) => `RM ${(n / 1000).toFixed(0)}k`}
    />
  </div>
);

export const Empty = () => (
  <div className="w-80">
    <DashboardBreakdown
      title="Returns by Reason"
      items={[]}
      emptyLabel="No returns recorded this month"
    />
  </div>
);
