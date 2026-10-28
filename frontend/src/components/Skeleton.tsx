import { cn } from "../lib/utils";

interface Props {
  className?: string;
}

export function Skeleton({ className }: Props) {
  return <div className={cn("skeleton rounded", className)} />;
}

/** Stacked placeholder bars for non-table lists (sidebar pickers, sub-panels). */
export function ListSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className={i % 2 === 0 ? "bg-surface" : "bg-surface-dim/35"}>
          {Array.from({ length: cols }).map((__, j) => (
            <td
              key={j}
              className={cn(
                "border-b border-border-subtle px-3 py-1.5 leading-tight",
                j === 0 && "pl-5",
                j === cols - 1 && "pr-5"
              )}
            >
              <Skeleton className="h-3.5 w-full max-w-[160px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
