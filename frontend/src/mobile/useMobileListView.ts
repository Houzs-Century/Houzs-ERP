import { useIdleSessionFilter } from "../hooks/useIdleSessionFilter";

/* Opening a card replaces the list screen, so the list remounts on Back: its search,
   chips and sort are kept per list for the session (cleared on logout or after an
   hour away), the phone side of the desktop lists' Back-keeps-your-place
   (Conts-ERP #406). */
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
