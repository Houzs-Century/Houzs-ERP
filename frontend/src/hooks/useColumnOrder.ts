import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { useLocalStorage } from './useLocalStorage';

export function normalizeColumnOrder<Key extends string>(saved: unknown, defaultKeys: readonly Key[]): Key[] {
  const knownKeys = new Set<string>(defaultKeys);
  const savedKeys = Array.isArray(saved)
    ? [...new Set(saved.filter((key): key is Key => typeof key === 'string' && knownKeys.has(key)))]
    : [];
  defaultKeys.forEach((key, defaultIndex) => {
    if (!savedKeys.includes(key)) savedKeys.splice(Math.min(defaultIndex, savedKeys.length), 0, key);
  });
  return savedKeys;
}

export function moveColumn<Key extends string>(order: readonly Key[], movingKey: Key, targetKey: Key): Key[] {
  const fromIndex = order.indexOf(movingKey);
  const toIndex = order.indexOf(targetKey);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [...order];
  const nextOrder = [...order];
  nextOrder.splice(fromIndex, 1);
  nextOrder.splice(toIndex, 0, movingKey);
  return nextOrder;
}

export interface ColumnHeaderProps {
  draggable: true;
  tabIndex: 0;
  title: string;
  'aria-keyshortcuts': string;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface ColumnOrder<Key extends string> {
  order: Key[];
  isCustom: boolean;
  dropTargetKey: Key | null;
  reset: () => void;
  headerProps: (key: Key, visibleKeys: readonly Key[]) => ColumnHeaderProps;
}

const KEYBOARD_STEP: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowRight: 1 };

export function useColumnOrder<Key extends string>(storageKey: string, defaultKeys: readonly Key[]): ColumnOrder<Key> {
  const [order, setOrder] = useLocalStorage<Key[]>(
    storageKey,
    [...defaultKeys],
    undefined,
    (saved) => normalizeColumnOrder(saved, defaultKeys),
  );
  const [draggingKey, setDraggingKey] = useState<Key | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<Key | null>(null);

  const endDrag = (): void => {
    setDraggingKey(null);
    setDropTargetKey(null);
  };

  const moveByKeyboard = (key: Key, visibleKeys: readonly Key[], event: KeyboardEvent<HTMLElement>): void => {
    const step = KEYBOARD_STEP[event.key];
    if (!event.altKey || step == null) return;
    const neighbourIndex = visibleKeys.indexOf(key) + step;
    if (neighbourIndex < 0 || neighbourIndex >= visibleKeys.length) return;
    event.preventDefault();
    setOrder((current) => moveColumn(current, key, visibleKeys[neighbourIndex]));
  };

  const headerProps = (key: Key, visibleKeys: readonly Key[]): ColumnHeaderProps => ({
    draggable: true,
    tabIndex: 0,
    title: 'Drag to move this column · Alt+Left / Alt+Right',
    'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key);
      setDraggingKey(key);
    },
    onDragOver: (event) => {
      if (draggingKey == null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTargetKey !== key) setDropTargetKey(key);
    },
    onDragLeave: () => {
      if (dropTargetKey === key) setDropTargetKey(null);
    },
    onDrop: (event) => {
      event.preventDefault();
      if (draggingKey != null) setOrder((current) => moveColumn(current, draggingKey, key));
      endDrag();
    },
    onDragEnd: endDrag,
    onKeyDown: (event) => moveByKeyboard(key, visibleKeys, event),
  });

  return {
    order,
    isCustom: order.some((key, index) => key !== defaultKeys[index]),
    dropTargetKey: draggingKey === dropTargetKey ? null : dropTargetKey,
    reset: () => setOrder([...defaultKeys]),
    headerProps,
  };
}
