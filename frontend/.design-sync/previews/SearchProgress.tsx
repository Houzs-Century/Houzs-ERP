import { SearchProgress } from "autocount-sync-frontend";

// Inline "Searching…" live-status chip — global search + list toolbars show
// it while a server-side search is in flight. Renders null when inactive, so
// both stories pin `active`.

export const Active = () => <SearchProgress active />;

export const CustomLabel = () => <SearchProgress active label="Matching 12,480 rows…" />;
