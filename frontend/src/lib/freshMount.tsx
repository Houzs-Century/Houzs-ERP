import { Fragment, useCallback, useState, type ReactNode } from "react";

export function FreshMount({ children }: { children: (startNew: () => void) => ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const startNew = useCallback(() => setGeneration((g) => g + 1), []);
  return <Fragment key={generation}>{children(startNew)}</Fragment>;
}
