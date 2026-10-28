import { useState } from "react";
import { FilterPills, Badge } from "autocount-sync-frontend";

// Compact in-page filter chip group in a rounded slab — filters the
// current view (navigation between views is <TabStrip/>).

export const Default = () => {
  const [v, setV] = useState("open");
  return (
    <FilterPills
      value={v}
      onChange={setV}
      options={[
        { value: "all", label: "All" },
        { value: "open", label: "Open" },
        { value: "delivered", label: "Delivered" },
        { value: "cancelled", label: "Cancelled" },
      ]}
    />
  );
};

export const TwoOptions = () => {
  const [v, setV] = useState("mine");
  return (
    <FilterPills
      value={v}
      onChange={setV}
      options={[
        { value: "mine", label: "My Cases" },
        { value: "team", label: "Whole Team" },
      ]}
    />
  );
};

export const ManyOptionsScroll = () => {
  const [v, setV] = useState("pending");
  return (
    <div className="w-72">
      <FilterPills
        value={v}
        onChange={setV}
        options={[
          { value: "all", label: "All" },
          { value: "pending", label: "Pending" },
          { value: "scheduled", label: "Scheduled" },
          { value: "in-transit", label: "In Transit" },
          { value: "delivered", label: "Delivered" },
          { value: "returned", label: "Returned" },
        ]}
      />
    </div>
  );
};

export const InContext = () => {
  const [v, setV] = useState("sla");
  return (
    <div className="flex w-[28rem] items-center justify-between rounded-lg border border-border bg-surface p-3 shadow-stone">
      <FilterPills
        value={v}
        onChange={setV}
        options={[
          { value: "all", label: "All" },
          { value: "sla", label: "SLA Risk" },
          { value: "warranty", label: "Warranty" },
        ]}
      />
      <Badge tone="error">3 breaches</Badge>
    </div>
  );
};
