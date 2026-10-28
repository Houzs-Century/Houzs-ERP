import { useState } from "react";
import { TabStrip } from "autocount-sync-frontend";

// Page-level underlined tab strip — petrol underline on the active view.
// For value filtering inside a view use <FilterPills/> instead.

export const Default = () => {
  const [tab, setTab] = useState("cases");
  return (
    <div className="w-[26rem]">
      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "cases", label: "Cases" },
          { value: "metrics", label: "Quality Metrics" },
        ]}
      />
    </div>
  );
};

export const WithCounts = () => {
  const [tab, setTab] = useState("queue");
  return (
    <div className="w-[28rem]">
      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "queue", label: "Queue", count: 14 },
          { value: "drafts", label: "Drafts", count: 3 },
          { value: "completed", label: "Completed", count: 128 },
        ]}
      />
    </div>
  );
};

export const HiddenTab = () => {
  const [tab, setTab] = useState("list");
  return (
    <div className="w-[26rem]">
      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "list", label: "List" },
          { value: "calendar", label: "Calendar" },
          { value: "admin", label: "Admin", show: false },
        ]}
      />
    </div>
  );
};

export const InContext = () => {
  const [tab, setTab] = useState("deliveries");
  return (
    <div className="w-[28rem] rounded-lg border border-border bg-surface px-4 pt-3 shadow-stone">
      <div className="mb-2 text-[13px] font-semibold text-ink">SO-2990-0417 — Farra Aziz</div>
      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "deliveries", label: "Deliveries", count: 2 },
          { value: "items", label: "Items", count: 6 },
          { value: "activity", label: "Activity" },
        ]}
        className="mb-0"
      />
    </div>
  );
};
