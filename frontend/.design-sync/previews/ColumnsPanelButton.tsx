import { ColumnsPanelButton, Badge } from "autocount-sync-frontend";

// Toolbar trigger for the ColumnsPanel drawer — lives next to Export/Density
// in DataTable headers. Two real axes: the visible/total count and the
// `active` state (panel currently open).

export const Default = () => (
  <ColumnsPanelButton visibleCount={7} totalCount={9} onClick={() => {}} />
);

export const Active = () => (
  <ColumnsPanelButton visibleCount={7} totalCount={9} onClick={() => {}} active />
);

export const InToolbar = () => (
  <div className="flex w-[36rem] items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 shadow-stone">
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-semibold text-ink">Sales Orders</span>
      <Badge tone="accent" size="xs">142</Badge>
    </div>
    <div className="flex items-center gap-2">
      <ColumnsPanelButton visibleCount={5} totalCount={9} onClick={() => {}} />
      <ColumnsPanelButton visibleCount={9} totalCount={9} onClick={() => {}} active />
    </div>
  </div>
);
