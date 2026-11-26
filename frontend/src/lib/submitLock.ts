import { useCallback, useRef, useState } from "react";

/** A single save on a form. `run` refuses while one is in flight. */
export function useSubmitLock(): { locked: boolean; run: <T>(save: () => Promise<T>) => Promise<T | undefined> } {
  const held = useRef(false);
  const [locked, setLocked] = useState(false);
  const run = useCallback(async <T>(save: () => Promise<T>): Promise<T | undefined> => {
    if (held.current) return undefined;
    held.current = true;
    setLocked(true);
    try {
      return await save();
    } finally {
      held.current = false;
      setLocked(false);
    }
  }, []);
  return { locked, run };
}

/** One lock per row (a payment draft), for a table that saves rows one by one. */
export function useKeyedSubmitLock(): {
  isLocked: (key: string) => boolean;
  run: <T>(key: string, save: () => Promise<T>) => Promise<T | undefined>;
} {
  const held = useRef(new Set<string>());
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(async <T>(key: string, save: () => Promise<T>): Promise<T | undefined> => {
    if (held.current.has(key)) return undefined;
    held.current.add(key);
    setShown(new Set(held.current));
    try {
      return await save();
    } finally {
      held.current.delete(key);
      setShown(new Set(held.current));
    }
  }, []);
  const isLocked = useCallback((key: string) => shown.has(key), [shown]);
  return { isLocked, run };
}

type Settle<D> = { onSuccess: (data: D) => unknown; onError: (error: unknown) => unknown };

/** `mutation.mutate(vars, { onSuccess, onError })`, as a promise that settles only
 *  once the chosen callback has finished — including its own awaits — so a lock
 *  held around it covers everything the save does after the request. */
export function settleMutation<V, D>(
  mutate: (vars: V, options: { onSuccess: (data: D) => void; onError: (error: unknown) => void }) => void,
  vars: V,
  handlers: Settle<D>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    mutate(vars, {
      onSuccess: (data) => { void Promise.resolve().then(() => handlers.onSuccess(data)).finally(resolve); },
      onError: (error) => { void Promise.resolve().then(() => handlers.onError(error)).finally(resolve); },
    });
  });
}
