import { PageSkeleton } from "autocount-sync-frontend";

// Whole-page loading fallback (route-level Suspense) — stat tiles +
// table rows shimmering. No props.

export const Default = () => (
  <div className="w-[30rem]">
    <PageSkeleton />
  </div>
);
