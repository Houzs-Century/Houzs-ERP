import { StatCard } from "autocount-sync-frontend";

// Atelier stat slab — brass top hairline, display-weight number.
// Used on Overview and every module dashboard strip.

export const Default = () => (
  <div className="w-56">
    <StatCard label="Open Sales Orders" value="142" subtitle="RM 386,420 order value" />
  </div>
);

export const Tones = () => (
  <div className="grid w-[34rem] grid-cols-2 gap-3">
    <StatCard label="Synced to AutoCount" value="1,204" tone="success" subtitle="Last sync 09:42" />
    <StatCard label="Pending Deliveries" value="17" tone="warning" subtitle="4 due today" />
    <StatCard label="SLA Breaches" value="3" tone="error" subtitle="ASSR-0231 oldest" />
    <StatCard label="Technicians On Site" value="9" subtitle="of 12 rostered" />
  </div>
);

export const ClickableAndActive = () => (
  <div className="grid w-[34rem] grid-cols-2 gap-3">
    <StatCard label="This Month Revenue" value="RM 512,830" subtitle="Click to drill down" onClick={() => {}} />
    <StatCard label="Outstanding DOs" value="26" subtitle="Selected filter" onClick={() => {}} active />
  </div>
);

export const WithRail = () => (
  <div className="grid w-[34rem] grid-cols-2 gap-3">
    <StatCard label="Aircon Installs" value="58" rail="bg-primary" subtitle="This month" />
    <StatCard label="Furniture Deliveries" value="34" rail="bg-accent" subtitle="This month" />
  </div>
);
