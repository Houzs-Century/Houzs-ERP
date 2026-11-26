import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ghostBtn, primaryBtn } from "../pos-admin/posAdminUi";

export function TripStatePicker({
  states,
  free,
  disabled,
  onChange,
}: {
  states: string[];
  free: string[];
  disabled: boolean;
  onChange: (states: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const toggle = (s: string) => setTicked((t) => (t.includes(s) ? t.filter((x) => x !== s) : [...t, s]));
  const add = () => {
    onChange([...states, ...ticked]);
    setTicked([]);
    setOpen(false);
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {states.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px]">
            {s}
            {!disabled && (
              <button type="button" aria-label={`Remove ${s}`} className="text-ink-muted hover:text-err" onClick={() => onChange(states.filter((x) => x !== s))}>
                <X size={10} />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button type="button" className={ghostBtn} disabled={!free.length} onClick={() => setOpen((o) => !o)}>
            <Plus size={11} /> Add states
          </button>
        )}
      </div>
      {open && (
        <div className="rounded-md border border-border bg-surface p-2">
          <div className="grid grid-cols-3 gap-1 max-sm:grid-cols-2">
            {free.map((s) => (
              <label key={s} className="flex items-center gap-1 text-[11.5px]">
                <input type="checkbox" checked={ticked.includes(s)} onChange={() => toggle(s)} />
                {s}
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={ghostBtn} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className={primaryBtn} disabled={!ticked.length} onClick={add}>
              Add {ticked.length}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
