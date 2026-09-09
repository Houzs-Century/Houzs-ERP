// ────────────────────────────────────────────────────────────────────────────
// Register — the department document register, the third mode of the
// Announcements page (owner 2026-09-09: "memo — 放在 Announcement 里面; 每个
// memo, SOP, warning, notice 都需要按部门编号").
//
// A department writes a memo, an SOP, a warning letter or a notice outside
// the ERP (Word / PDF) and needs the official number for it. Register it here
// — type, title, department, date, the file — and the number is minted at
// once: <DEPT>-<TYPE>-<YYMM>-NNNN, one sequence per department, type and
// month, shared with a notice of the same type composed in the ERP
// (docs/modules/memos.md). A registered document is numbered, so it is never
// deleted: it is voided with a reason. Any signed-in user registers for their
// own department; memos.manage (or the owner wildcard) for any department and
// voids anyone's. The API keeps its original name: /api/memos.
// ────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { Download, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import { fmtDate, fmtDateTime } from "../../vendor/shared/format";
import type { Department } from "../../types";
import type { DocumentTypeOption } from "./announcementModel";

export type RegisteredDocument = {
  id: string;
  refNo: string | null;
  title: string;
  departmentId: number;
  departmentName: string | null;
  deptCode: string;
  docType: string;
  memoDate: string;
  notes: string | null;
  file: { name: string | null; mime: string | null; size: number | null } | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  voidedBy: number | null;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
};

/** The default family when the registry offers it; else the first offered. */
const DEFAULT_TYPE = "MEMO";
/** Composed in Announcements, never registered here. */
const COMPOSED_TYPE = "ANN";

const FIELD = "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-primary";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-ink-muted";

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function RegisterView({ docTypes, className }: { docTypes: DocumentTypeOption[]; className?: string }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("memos.manage");
  const myDeptId = user?.department_id ?? null;

  // The families a document written outside the ERP can be registered as:
  // every ACTIVE registry type but ANN (the page's own /api/document-types
  // read, so Settings → Documents governs this list too).
  const registrableTypes = useMemo(() => docTypes.filter((t) => t.code !== COMPOSED_TYPE), [docTypes]);
  const typeLabel = useMemo(() => new Map(docTypes.map((t) => [t.code, t.label])), [docTypes]);

  const [deptFilter, setDeptFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [showVoided, setShowVoided] = useState(false);
  const listPath = `/api/memos?includeVoided=${showVoided ? 1 : 0}${deptFilter ? `&departmentId=${deptFilter}` : ""}${typeFilter ? `&docType=${typeFilter}` : ""}`;
  const listQ = useQuery<{ data: RegisteredDocument[] }>(listPath, () => api.get(listPath), [listPath]);
  const deptsQ = useQuery<{ departments: Department[] }>("/api/departments", () => api.get("/api/departments"));

  const departments = useMemo(() => deptsQ.data?.departments ?? [], [deptsQ.data]);
  const registrable = useMemo(
    () => (canManage ? departments : departments.filter((d) => d.id === myDeptId)),
    [canManage, departments, myDeptId],
  );

  // ── Register form ─────────────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [deptId, setDeptId] = useState<string>(myDeptId ? String(myDeptId) : "");
  const [memoDate, setMemoDate] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<{ r2Key: string; name: string; mime: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // The picked type, or the default once the registry has answered.
  const typeChosen: DocumentTypeOption | null =
    registrableTypes.find((t) => t.code === docType) ??
    registrableTypes.find((t) => t.code === DEFAULT_TYPE) ??
    (registrableTypes.length > 0 ? registrableTypes[0] : null);
  const needsFile = !!typeChosen?.attachmentRequired;

  async function pickFile(f: File | null) {
    if (!f) return;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    setUploading(true);
    try {
      const res = await api.putBinary<{ r2Key: string; mime: string; size: number }>(
        `/api/memos/upload?ext=${ext}`,
        f,
        f.type || "application/octet-stream",
      );
      setFile({ r2Key: res.r2Key, name: f.name, mime: res.mime, size: res.size });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const deptChosen = registrable.find((d) => String(d.id) === deptId) ?? null;
  const deptHasCode = !!deptChosen?.code;
  const canRegister =
    !saving && !uploading && title.trim().length > 0 && !!typeChosen && !!deptChosen && deptHasCode && (!needsFile || !!file);

  async function register() {
    // canRegister is an aliased condition: TS narrows typeChosen / deptChosen past it.
    if (!canRegister) return;
    setSaving(true);
    try {
      const r = await api.post<{ data?: RegisteredDocument | null }>("/api/memos", {
        title: title.trim(),
        docType: typeChosen.code,
        departmentId: deptChosen.id,
        memoDate,
        notes: notes.trim() || undefined,
        file: file ?? undefined,
      });
      toast.success(r.data?.refNo ? `Registered as ${r.data.refNo}` : "Document registered");
      setTitle("");
      setNotes("");
      setFile(null);
      setMemoDate(todayIso());
      setOpen(false);
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function voidDocument(m: RegisteredDocument) {
    const reason = await dialog.prompt({
      title: "Void document",
      message: `${m.refNo ?? m.title} keeps its number and is marked void. This cannot be undone.`,
      placeholder: "Why it is being voided",
      confirmLabel: "Void",
      danger: true,
      required: true,
      multiline: true,
    });
    if (reason == null || !reason.trim()) return;
    try {
      await api.post(`/api/memos/${m.id}/void`, { reason: reason.trim() });
      toast.success("Document voided");
      listQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  const rows = listQ.data?.data ?? [];
  const canRegisterAny = registrable.length > 0 && registrableTypes.length > 0;

  // The number Register would mint right now (owner 2026-09-09: 需要显示目前档案
  // 号码) — a preview from GET /api/document-refs/next, nothing claimed; it
  // follows the picked department + type and refreshes after each registration.
  const [nextRef, setNextRef] = useState<string | null>(null);
  const peekDept = deptChosen?.code ?? null;
  const peekType = typeChosen?.code ?? null;
  const listVersion = listQ.data;
  useEffect(() => {
    if (!open || !peekDept || !peekType) {
      setNextRef(null);
      return;
    }
    const gone = new AbortController();
    void (async () => {
      try {
        const r = await api.get<{ data?: { refNo?: string } | null }>(`/api/document-refs/next?typeCode=${peekType}&deptCode=${peekDept}`);
        if (!gone.signal.aborted) setNextRef(r.data?.refNo ?? null);
      } catch {
        if (!gone.signal.aborted) setNextRef(null);
      }
    })();
    return () => gone.abort();
  }, [open, peekDept, peekType, listVersion]);

  return (
    <div className={className} data-testid="register-view">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-[12.5px] text-ink-secondary">
          The department document register — a memo, SOP, warning or notice written outside the ERP gets its official number here.
        </p>
        {canRegisterAny && (
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen((v) => !v)} className="ml-auto">
            Register a document
          </Button>
        )}
      </div>

      {open && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-stone" data-testid="register-form">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_220px_160px]">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Type</span>
              <select value={typeChosen?.code ?? ""} onChange={(e) => setDocType(e.target.value)} aria-label="Document type" className={FIELD}>
                {registrableTypes.length === 0 && <option value="">No type</option>}
                {registrableTypes.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label} ({t.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What the document is about" aria-label="Document title" maxLength={200} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Department</span>
              <select value={deptId} onChange={(e) => setDeptId(e.target.value)} aria-label="Department" className={FIELD} disabled={!canManage}>
                {registrable.length === 0 && <option value="">No department</option>}
                {registrable.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}
                    {d.code ? ` (${d.code})` : " — no code"}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Document date</span>
              <DateField fullWidth value={memoDate} onChange={(iso) => setMemoDate(iso)} aria-label="Document date" className={FIELD} />
            </label>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_320px]">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" rows={2} className={cn(FIELD, "h-auto py-2")} placeholder="Optional" />
            </label>
            <div className="flex flex-col gap-1">
              <span className={LABEL}>File{needsFile ? " · required" : ""}</span>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  aria-label="Document file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,image/*"
                  disabled={uploading}
                  onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
                  className="text-[12px] text-ink-secondary"
                />
              </div>
              <span className="text-[11px] text-ink-muted">
                {uploading
                  ? "Uploading…"
                  : file
                    ? `${file.name} · ready`
                    : needsFile
                      ? `A ${typeChosen.label} must carry its file (Settings → Documents).`
                      : "PDF, Word, Excel or an image, up to 25MB."}
              </span>
            </div>
          </div>
          {deptChosen && !deptHasCode && (
            <p className="mt-2 text-[12px] text-err">
              {deptChosen.name} has no department code yet, so it cannot number documents. Set one under Team → Departments.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" onClick={() => void register()} disabled={!canRegister}>
              {saving ? "Registering…" : "Register & number"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <span className="ml-auto text-[11px] text-ink-muted" data-testid="ref-no-preview">
              {nextRef ? (
                <>
                  Next number on Register: <span className="font-mono font-semibold text-ink">{nextRef}</span>
                </>
              ) : (
                <>The number is minted on Register: {deptChosen?.code ?? "DEPT"}-{typeChosen?.code ?? "TYPE"}-YYMM-NNNN, this department's own sequence for the type and month.</>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className={cn(FIELD, "w-auto min-w-[160px]")}>
          <option value="">All types</option>
          {registrableTypes.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Filter by department" className={cn(FIELD, "w-auto min-w-[200px]")}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={String(d.id)}>
              {d.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} aria-label="Show voided" />
          Show voided
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-stone">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              <th className="px-4 py-2">Ref no</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Department</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">File</th>
              <th className="px-4 py-2">Registered</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {listQ.loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink-muted">Loading…</td>
              </tr>
            )}
            {!listQ.loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ink-muted">Nothing registered yet.</td>
              </tr>
            )}
            {rows.map((m) => {
              const voided = m.voidedAt != null;
              const mayVoid = !voided && (canManage || (user?.id != null && m.createdBy === user.id));
              return (
                <tr key={m.id} className={cn("border-b border-border-subtle last:border-b-0", voided && "text-ink-muted")} data-testid={`register-row-${m.id}`}>
                  <td className={cn("px-4 py-2 font-mono font-semibold", voided ? "line-through" : "text-ink")}>{m.refNo ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ink-secondary" title={typeLabel.get(m.docType) ?? m.docType}>
                      {m.docType}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className={cn(voided && "line-through")}>{m.title}</div>
                    {voided && (
                      <div className="text-[11px] text-ink-muted">
                        Voided by {m.voidedByName ?? "?"}{m.voidedAt ? ` · ${fmtDateTime(m.voidedAt)}` : ""}: {m.voidReason ?? "no reason recorded"}
                      </div>
                    )}
                    {!voided && m.notes && <div className="text-[11px] text-ink-secondary">{m.notes}</div>}
                  </td>
                  <td className="px-4 py-2">{m.departmentName ?? m.deptCode}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">{m.memoDate ? fmtDate(m.memoDate) : "—"}</td>
                  <td className="px-4 py-2">
                    {m.file ? (
                      <button
                        type="button"
                        onClick={() => void api.downloadFile(`/api/memos/${m.id}/file`, m.file?.name ?? "document")}
                        className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
                      >
                        <Download size={12} />
                        {m.file.name ?? "Download"}
                      </button>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[11.5px] text-ink-secondary">
                    {m.createdByName ?? "?"}{m.createdAt ? ` · ${fmtDateTime(m.createdAt)}` : ""}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {mayVoid && (
                      <button
                        type="button"
                        onClick={() => void voidDocument(m)}
                        className="rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[11px] font-[650] text-err hover:bg-err/5"
                      >
                        Void…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
