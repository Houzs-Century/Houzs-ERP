// ---------------------------------------------------------------------------
// FreshMount — "start another" for a create form whose MOUNT is its intent.
//
// A create page that mints its idempotency key per mount (lib/idempotency.ts)
// cannot offer "New <document>" by navigating to its own route: the router
// treats that as a no-op, the component survives, the key survives, and the
// operator's next, DIFFERENT document goes out under the first one's key — the
// server replays document #1 (or refuses idempotency_key_reused) and nothing
// new is written. Resetting the fields by hand has the same hole. GrnNew.tsx
// dodges it by sending "New GRN" to a different route; a form with no picker
// route in front of it needs this instead.
//
// `startNew` bumps the key on the wrapper, so React throws the whole subtree
// away and mounts a new one: every useState (the key included) starts over.
// ---------------------------------------------------------------------------
import { Fragment, useCallback, useState, type ReactNode } from "react";

export function FreshMount({ children }: { children: (startNew: () => void) => ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const startNew = useCallback(() => setGeneration((g) => g + 1), []);
  return <Fragment key={generation}>{children(startNew)}</Fragment>;
}
