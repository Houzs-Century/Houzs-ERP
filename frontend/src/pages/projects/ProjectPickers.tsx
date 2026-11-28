import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";


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
          void addNew();
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
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
      <option value={SENTINEL_NEW}>+ Add new organizer…</option>
    </select>
  );
}

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
    /* A new venue carries its postcode (owner 2026-11-19); Project Maintenance
       fills City and State from it. */
    const postcode = await dialog.prompt({
      title: "Venue postcode",
      message: `Postcode of ${name}. It places the venue on Last Mile and fills City and State.`,
      placeholder: "e.g. 47500",
      required: true,
      confirmLabel: "Add",
    });
    if (!postcode) return;
    try {
      const r = await api.post<{ id: number; name: string; state: string | null }>(
        "/api/projects/venues",
        { name, postcode: postcode.trim() }
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
      <option value={SENTINEL_NEW}>+ Add new venue…</option>
    </select>
  );
}
