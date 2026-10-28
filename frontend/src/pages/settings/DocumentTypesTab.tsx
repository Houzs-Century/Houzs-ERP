// Settings → Documents — the document-type registry (mig 20260906T1417,
// `docs/modules/document-refs.md`) and the one policy it carries today:
// "attachment required before submit". Owner 2026-09-06 ("标准化编号与文档
// 管理": 强制附件, 可配置的类型). The registry is global (not per company);
// reading is open to any signed-in user, editing needs settings.manage —
// the same gate the API applies to POST / PATCH /api/document-types.
import { useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { ListSkeleton } from "../../components/Skeleton";
import { cn } from "../../lib/utils";

export type DocumentType = {
  code: string;
  label: string;
  attachmentRequired: boolean;
  isActive: boolean;
};

const CODE_RE = /^[A-Za-z]{2,4}$/;

export function DocumentTypesTab() {
  const { can } = useAuth();
  const canEdit = can("settings.manage");
  const toast = useToast();
  const typesQ = useQuery<{ data: DocumentType[] }>("/api/document-types?all=1", () =>
    api.get("/api/document-types?all=1"),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");

  async function patch(t: DocumentType, body: Partial<Pick<DocumentType, "attachmentRequired" | "isActive">>) {
    if (!canEdit || busy) return;
    setBusy(t.code);
    try {
      await api.patch(`/api/document-types/${t.code}`, body);
      toast.success(
        body.attachmentRequired != null
          ? body.attachmentRequired
            ? `${t.label}: an attachment is now required before submit`
            : `${t.label}: attachment no longer required`
          : body.isActive
            ? `${t.label} is active`
            : `${t.label} is inactive`,
      );
      typesQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const c = code.trim().toUpperCase();
    if (!CODE_RE.test(c) || !label.trim() || busy) return;
    setBusy("new");
    try {
      await api.post("/api/document-types", { code: c, label: label.trim() });
      toast.success(`Added ${c}`);
      setCode("");
      setLabel("");
      setAdding(false);
      typesQ.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const types = typesQ.data?.data ?? [];
  const codeOk = code.trim() === "" || CODE_RE.test(code.trim());

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-muted">
            Document types
          </span>
          {canEdit && !adding && (
            <Button variant="secondary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              New type
            </Button>
          )}
        </div>
        {typesQ.loading ? (
          <div className="p-4">
            <ListSkeleton rows={3} />
          </div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2">Code</th>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Attachment required before submit</th>
                <th className="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.code} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-4 py-2 font-mono font-semibold text-ink">{t.code}</td>
                  <td className="px-4 py-2 text-ink">{t.label}</td>
                  <td className="px-4 py-2">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={t.attachmentRequired}
                        disabled={!canEdit || busy != null}
                        onChange={(e) => void patch(t, { attachmentRequired: e.target.checked })}
                        aria-label={`Attachment required for ${t.label}`}
                      />
                      <span className="text-ink-secondary">
                        {t.attachmentRequired ? "Required" : "Optional"}
                      </span>
                    </label>
                  </td>
                  <td className="px-4 py-2">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={t.isActive}
                        disabled={!canEdit || busy != null}
                        onChange={(e) => void patch(t, { isActive: e.target.checked })}
                        aria-label={`${t.label} active`}
                      />
                      <span className="text-ink-secondary">{t.isActive ? "Active" : "Inactive"}</span>
                    </label>
                  </td>
                </tr>
              ))}
              {types.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                    No document types registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {adding && (
          <div className="flex flex-wrap items-end gap-3 border-t border-border bg-surface-2 px-4 py-3">
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              Code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={4}
                placeholder="e.g. SOP"
                aria-label="Type code"
                className={cn(
                  "h-9 w-24 rounded-md border bg-surface px-2.5 font-mono text-[12px] uppercase text-ink outline-none focus:border-primary",
                  codeOk ? "border-border" : "border-err",
                )}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Standard operating procedure"
                aria-label="Type label"
                className="h-9 w-64 rounded-md border border-border bg-surface px-2.5 text-[12px] text-ink outline-none focus:border-primary"
              />
            </label>
            <Button variant="primary" onClick={() => void create()} disabled={!CODE_RE.test(code.trim()) || !label.trim() || busy != null}>
              Add type
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <span className="basis-full text-[11px] text-ink-muted">
              The code is the [TYPE] segment of a reference number (OPS-ANN-2609-0001): 2 to 4 letters.
            </span>
          </div>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        "Attachment required" stops a document of that type from being submitted for approval without a
        file — a draft can still be saved. Today the Announcements composer reads the ANN row; other
        document families pick this up as they join the reference-number scheme.
      </p>
    </div>
  );
}
