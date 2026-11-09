// A list that failed to load says so and offers a way out. DataTable used to show
// "Failed to load" with the raw error text and nothing to press, so the only
// recovery was a full page reload (Conts-ERP #594).
import { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";

/** Retry refetches the queries on screen. A table fed without a query client reloads the page. */
export function TableLoadError({ error }: { error: string }) {
  const client = useContext(QueryClientContext);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    if (!client) {
      window.location.reload();
      return;
    }
    setBusy(true);
    try {
      await client.refetchQueries({ type: "active" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="font-semibold text-ink">Couldn't load this list.</div>
      {error && error !== "Failed to load" && <div className="text-xs text-ink-muted">{error}</div>}
      <button
        type="button"
        onClick={() => void retry()}
        disabled={busy}
        className="mt-1 h-9 rounded-md border border-border bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
      >
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
