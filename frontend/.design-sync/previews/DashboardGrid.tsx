import { DashboardGrid, StatCard } from "autocount-sync-frontend";

// The stat strip at the top of each tab page — a responsive grid of
// StatCard slabs (2-up on mobile, cols prop at lg+). Children are the
// cards; the grid only owns the column rhythm.

export const FourStats = () => (
  <div className="w-[52rem]">
    <DashboardGrid cols={4}>
      <StatCard label="Open Sales Orders" value="128" subtitle="+12 this week" />
      <StatCard
        label="Pending Sync"
        value="12"
        tone="warning"
        subtitle="AutoCount sync paused"
      />
      <StatCard label="Overdue SLA" value="3" tone="error" subtitle="ASSR cases" />
      <StatCard label="Delivered Today" value="86" tone="success" subtitle="of 91 stops" />
    </DashboardGrid>
  </div>
);

export const FiveWithRails = () => (
  <div className="w-[56rem]">
    <DashboardGrid cols={5}>
      <StatCard label="Revenue MTD" value="RM 288k" rail="bg-primary" />
      <StatCard label="Gross Profit" value="RM 96k" tone="success" rail="bg-synced" />
      <StatCard label="Open POs" value="41" rail="bg-accent" />
      <StatCard label="Service Cost" value="RM 8.2k" tone="warning" rail="bg-warning-text" />
      <StatCard label="Cancelled" value="5" tone="error" rail="bg-err" />
    </DashboardGrid>
  </div>
);

export const TwoUpDrilldown = () => (
  <div className="w-[36rem]">
    <DashboardGrid cols={2}>
      <StatCard
        label="Trips Today"
        value="14"
        subtitle="2 unassigned"
        onClick={() => {}}
        active
      />
      <StatCard label="POD Photos Missing" value="6" tone="warning" onClick={() => {}} />
    </DashboardGrid>
  </div>
);
