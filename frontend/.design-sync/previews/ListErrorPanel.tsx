import { ListErrorPanel } from "autocount-sync-frontend";

// Full-width load-failure panel for list surfaces — role="alert", err-tinted
// border/background, muted detail line under the bold headline.

export const Default = () => (
  <div className="w-[520px]">
    <ListErrorPanel />
  </div>
);

export const CustomMessage = () => (
  <div className="w-[520px]">
    <ListErrorPanel message="The server took too long to answer — try again in a moment." />
  </div>
);
