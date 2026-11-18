// "From last event" — the previous same-organiser-venue-and-brand event's Expo Map
// files (Blank / Filled Floorplan), shown read-only in this event's EXPO MAP
// section while it has none of its own (owner 2026-11-18). The server decides
// which event and whether to send it (backend services/eventForecastLoad.ts).
// Desktop and phone render this same block.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { openLoadedTab } from "../../lib/openLoadedTab";
import { viewableMime } from "./projectHelpers";
import type { LastEventExpoMap } from "./forecastLayers";

export function LastEventExpoMapBlock({ data }: { data: LastEventExpoMap }) {
  const [error, setError] = useState<string | null>(null);
  const label = data.last_event.code || data.last_event.name || `#${data.last_event.id}`;
  async function open(r2Key: string, fileName: string) {
    setError(null);
    try {
      await openLoadedTab(() => api.fetchBlobUrl(`/api/projects/attachments/${r2Key}`, viewableMime(fileName)), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be opened.");
    }
  }
  return (
    <div className="mx-4 my-2 rounded-md border border-dashed border-border bg-surface-2/50 px-3 py-2 text-[12px]" data-testid="last-event-expo-map">
      <div className="font-semibold text-ink-secondary">
        From last event: <Link className="text-accent hover:underline" to={`/projects/${data.last_event.id}`}>{label}</Link>
        <span className="ml-1.5 font-normal text-ink-muted">· read only, for reference</span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {data.files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-ink-muted">{f.item_title}</span>
            <button type="button" className="break-all text-left text-accent hover:underline" onClick={() => void open(f.r2_key, f.file_name)}>
              {f.file_name}
            </button>
          </li>
        ))}
      </ul>
      {error && <div role="alert" className="mt-1 text-err">{error}</div>}
    </div>
  );
}
