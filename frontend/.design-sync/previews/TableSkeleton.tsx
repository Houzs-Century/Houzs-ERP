import { TableSkeleton } from "autocount-sync-frontend";

// Shimmer rows for data tables while a page loads. Renders <tr> rows —
// must live inside a <table><tbody>.

export const FiveBySix = () => (
  <table className="w-[28rem] border-collapse overflow-hidden rounded-lg border border-border bg-surface text-left shadow-stone">
    <tbody>
      <TableSkeleton />
    </tbody>
  </table>
);

export const CompactThreeByFour = () => (
  <table className="w-80 border-collapse overflow-hidden rounded-lg border border-border bg-surface text-left shadow-stone">
    <tbody>
      <TableSkeleton rows={3} cols={4} />
    </tbody>
  </table>
);

export const WithHeader = () => (
  <table className="w-[28rem] border-collapse overflow-hidden rounded-lg border border-border bg-surface text-left shadow-stone">
    <thead>
      <tr className="bg-surface-2">
        {["Doc No", "Customer", "Date", "Amount"].map((h) => (
          <th
            key={h}
            className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted first:pl-5 last:pr-5"
          >
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      <TableSkeleton rows={4} cols={4} />
    </tbody>
  </table>
);
