import { useEffect, useState } from "react";

/**
 * Drag-and-drop + arrow-button row ordering helper. Mirrors the
 * pattern used by the checklist-template editor (Project Maintenance):
 * grip handle on each row, ChevronUp/ChevronDown arrows, optimistic
 * local state, and a bulk-id endpoint to persist the new order.
 *
 * Usage:
 *   const r = useReorderable(items, (ids) => api.put('.../reorder', { ids }));
 *   // In each row: r.handlers(item.id), r.moveBy(idx, -1), r.isDragging(id)
 *
 * The hook re-syncs `localOrder` whenever the upstream `items` array
 * changes (e.g. after a refetch), so the caller doesn't need to
 * micromanage state when adds / deletes land.
 */
export function useReorderable<T extends { id: number }>(
  items: T[],
  persist: (orderedIds: number[]) => Promise<void>,
) {
  const [localOrder, setLocalOrder] = useState<T[] | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  // Keep localOrder in lockstep with `items` whenever the upstream
  // refetches. Using JSON.stringify of ids as the dep is cheap and
  // avoids the array-identity churn that would otherwise loop.
  const sig = items.map((i) => i.id).join(",");
  useEffect(() => {
    setLocalOrder(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const view = localOrder ?? items;

  function moveBy(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= view.length) return;
    const next = view.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    setLocalOrder(next);
    void persist(next.map((i) => i.id));
  }

  function onDragStart(e: React.DragEvent, id: number) {
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
    setDragId(id);
  }

  function onDragOver(e: React.DragEvent, overId: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverId !== overId) setDragOverId(overId);
  }

  function onDragLeave(overId: number) {
    if (dragOverId === overId) setDragOverId(null);
  }

  function onDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    setDragOverId(null);
    const sourceId = parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDragId(null);
    if (!sourceId || sourceId === targetId) return;
    const sourceIdx = view.findIndex((i) => i.id === sourceId);
    const targetIdx = view.findIndex((i) => i.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = view.slice();
    const [moved] = next.splice(sourceIdx, 1);
    const targetAdj = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(targetAdj, 0, moved);
    setLocalOrder(next);
    void persist(next.map((i) => i.id));
  }

  function onDragEnd() {
    setDragId(null);
    setDragOverId(null);
  }

  function rowHandlers(id: number) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => onDragStart(e, id),
      onDragOver: (e: React.DragEvent) => onDragOver(e, id),
      onDragLeave: () => onDragLeave(id),
      onDrop: (e: React.DragEvent) => onDrop(e, id),
      onDragEnd,
    };
  }

  return {
    view,
    moveBy,
    rowHandlers,
    isDragging: (id: number) => dragId === id,
    isDropTarget: (id: number) => dragOverId === id && dragId !== id,
  };
}
