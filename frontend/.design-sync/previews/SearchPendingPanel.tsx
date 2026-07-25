import { SearchPendingPanel } from "autocount-sync-frontend";

// Full-width busy panel a list shows in place of its table while a server
// search is still resolving — the panel version of SearchProgress.

export const Default = () => (
  <div className="w-[520px]">
    <SearchPendingPanel />
  </div>
);

export const CustomLabel = () => (
  <div className="w-[520px]">
    <SearchPendingPanel label="Searching all sales orders…" />
  </div>
);
