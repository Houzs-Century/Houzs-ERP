import { useIdleSessionFilter } from "../hooks/useIdleSessionFilter";

export function useMobileListView(listId: string, defaultSort: string) {
  const [view, patch] = useIdleSessionFilter(
    `mobile-list:${listId}`,
    { q: "", chip: "all", chip2: "all", sortKey: defaultSort },
    60 * 60 * 1000,
  );
  return {
    ...view,
    setQ: (q: string) => patch({ q }),
    setChip: (chip: string) => patch({ chip }),
    setChip2: (chip2: string) => patch({ chip2 }),
    setSortKey: (sortKey: string) => patch({ sortKey }),
  };
}
