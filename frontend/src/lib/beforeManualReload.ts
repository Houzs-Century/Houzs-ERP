
const hooks = new Set<() => void>();

export function onBeforeManualReload(hook: () => void): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Never throws: a hook that fails must not stop the reload it runs before. */
export function runBeforeManualReload(): void {
  for (const hook of [...hooks]) {
    try {
      hook();
    } catch {
    }
  }
}
