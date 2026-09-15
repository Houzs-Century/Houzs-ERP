import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";

// ── Organizer picker ─────────────────────────────────────────
// Combobox-style: select from existing organizers OR add a new one
// inline. Picks land in projects.organizer (free text) and also get
// recorded in project_organizers so the next project sees them.

export function OrganizerPicker({
  value,
  onChange,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/organizers",
    () => api.get("/api/projects/organizers"),
    []
  );
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add organizer",
      message: "Add a new organizer to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. PIKOM",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      await api.post("/api/projects/organizers", { name });
      await q.reload();
      onChange(name);
      toast.success(`Added ${name}`);
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          // Don't commit the sentinel — open the prompt and let it
          // call onChange with the actual new name.
          void addNew(); // same idiom as the other async handlers here (:2116, :7691)
          return;
        }
        onChange(v || null);
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select organizer —</option>
      {/* Surface legacy values that aren't in the lookup yet */}
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new organizer…</option>
    </select>
  );
}

// Same pattern as OrganizerPicker but for project_venues. Includes an
// optional `state` callback that fires when the picked venue carries a
// state hint, so the create form can pre-fill the state field.
export function VenuePicker({
  value,
  onChange,
  onStateHint,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  onStateHint?: (state: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{
    data: { id: number; name: string; state: string | null }[];
  }>("/api/projects/venues", () => api.get("/api/projects/venues"), []);
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add venue",
      message:
        "Add a new venue to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. KLCC Convention Centre",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      const r = await api.post<{ id: number; name: string; state: string | null }>(
        "/api/projects/venues",
        { name }
      );
      await q.reload();
      onChange(r.name);
      if (r.state && onStateHint) onStateHint(r.state);
      toast.success(`Added ${r.name}`);
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          void addNew();
          return;
        }
        onChange(v || null);
        if (v && onStateHint) {
          const match = options.find((o) => o.name === v);
          if (match?.state) onStateHint(match.state);
        }
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select venue —</option>
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
          {o.state ? ` · ${o.state}` : ""}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new venue…</option>
    </select>
  );
}
