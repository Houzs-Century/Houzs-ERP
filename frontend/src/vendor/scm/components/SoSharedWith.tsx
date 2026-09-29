// SoSharedWith — the "Shared with" field on the SO detail screen, desktop and
// mobile. Viewers see the names; a user holding scm.so.attribute_other (the
// same gate the /so-handover/share endpoint enforces) can add or withdraw
// people on THIS order only.
//
// `frame` is how each surface keeps its own field chrome: desktop wraps the
// body in its `Field`, mobile in its `RoField`. Which names, who may edit, and
// what the server said stay here, so the two surfaces cannot drift.
import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useAuth as useHouzsAuth } from "../../../auth/AuthContext";
import { SearchableSelect } from "./SearchableSelect";
import { usePickableStaff } from "../lib/admin-queries";
import {
  collaboratorEntries,
  type CollaboratorHeader,
  type CollaboratorStaff,
} from "../lib/so-collaborators";
import { useShareSalesOrder } from "../lib/so-share-queries";

export function SoSharedWith({
  docNo,
  header,
  staff,
  frame,
}: {
  docNo: string;
  header: (CollaboratorHeader & { salesperson_id?: string | number | null }) | null;
  staff: readonly CollaboratorStaff[] | null | undefined;
  frame: (body: ReactNode) => ReactNode;
}) {
  const canShare = useHouzsAuth().can("scm.so.attribute_other");
  const entries = collaboratorEntries(header, staff);
  if (!canShare) {
    return entries.length === 0 ? null : <>{frame(entries.map((e) => e.name).join(", "))}</>;
  }
  return <>{frame(<ShareEditor docNo={docNo} header={header} entries={entries} />)}</>;
}

function ShareEditor({
  docNo,
  header,
  entries,
}: {
  docNo: string;
  header: { salesperson_id?: string | number | null } | null;
  entries: Array<{ id: string; name: string }>;
}) {
  const pickableQ = usePickableStaff();
  const share = useShareSalesOrder();
  const [error, setError] = useState<string | null>(null);

  const taken = new Set([...entries.map((e) => e.id), String(header?.salesperson_id ?? "")]);
  const options = (pickableQ.data ?? [])
    .filter((s) => !taken.has(s.id))
    .map((s) => ({ value: s.id, label: s.name }));

  const run = (staffId: string, mode: "add" | "remove") => {
    setError(null);
    share.mutate(
      { docNo, staffId, mode },
      { onError: (e) => setError(e instanceof Error ? e.message : "Could not update sharing.") },
    );
  };

  return (
    <div className="space-y-1.5">
      {entries.length === 0 ? (
        <div className="text-[13px] font-normal text-ink-muted">Not shared</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <span
              key={e.id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[12px] font-medium text-ink"
            >
              {e.name}
              <button
                type="button"
                aria-label={`Stop sharing with ${e.name}`}
                title={`Stop sharing with ${e.name}`}
                disabled={share.isPending}
                onClick={() => run(e.id, "remove")}
                className="text-ink-muted hover:text-err disabled:opacity-50"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchableSelect
        value=""
        ariaLabel="Share this order with"
        placeholder={share.isPending ? "Saving…" : "Add a person…"}
        disabled={share.isPending || pickableQ.isLoading}
        options={options}
        className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] font-normal text-ink outline-none focus:border-primary disabled:opacity-60"
        onChange={(v) => {
          if (v) run(v, "add");
        }}
      />
      {error && <div className="text-[12px] font-normal text-err">{error}</div>}
    </div>
  );
}
