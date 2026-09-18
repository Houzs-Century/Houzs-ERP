/* Per-file chip + remove control for the mobile Floor-Plans tiles.
 *
 * Lifted out of MobilePMS.tsx for the same reason MobilePmsDefectActions was:
 * that file is one of the largest in the repo and sits on a size ceiling, so
 * new UI goes into its own module rather than growing it. The delete path is
 * also easier to drive from a test here than through the whole PMS surface.
 *
 * Owner 2026-08-24: "display floorplan i cant remove existing file using
 * mobile". The plan tiles were VIEW-only — a tap opened the lightbox and that
 * was the whole interaction — while the tasklist rows that carry the chips and
 * their × are hidden for every mobile cohort. So on a phone there was no way to
 * remove, or replace, a plan already uploaded.
 */
import type { ReactNode } from "react";
import { api } from "../api/client";

export type PlanChipFile = {
  id: number;
  file_name: string | null;
};

type NotifyFn = (o: { title: string; body?: ReactNode; tone?: "info" | "error" }) => Promise<void>;
type ConfirmFn = (o: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

/* One chip per file with its ×. Rendered ONLY for real task attachments — the
   legacy project-level plans the Unfilled/Filled tiles fall back to are a
   different store and this endpoint would not find them. Every control
   stopPropagation()s, or the tap opens the lightbox instead of removing. */
export function PlanFileChips({
  files,
  busy,
  setBusy,
  confirm,
  notify,
  reload,
}: {
  files: readonly PlanChipFile[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  confirm?: ConfirmFn;
  notify: NotifyFn;
  reload: () => void;
}) {
  if (files.length === 0) return null;

  // Same endpoint the tasklist chip and the stock-transfer row use — the file
  // belongs to the checklist task either way, so all three surfaces stay one
  // file.
  const removeFile = async (attId: number, name: string | null) => {
    if (confirm && !(await confirm({ title: `Remove ${name || "this file"}?`, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/checklist/attachments/${attId}`);
      reload();
    } catch (e) {
      await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {files.map((a) => (
        <span
          key={a.id}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
            border: "1px solid #e3e6e0", borderRadius: 7, padding: "2px 4px 2px 6px",
            fontSize: 10, color: "#414539", background: "#fbfcfa",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 128 }}>
            {a.file_name || "file"}
          </span>
          <button
            className="tinybtn"
            disabled={busy}
            aria-label={`Remove ${a.file_name || "file"}`}
            title="Remove file"
            style={{ color: "#a13a34", padding: "1px 6px", fontWeight: 700 }}
            onClick={(e) => { e.stopPropagation(); void removeFile(a.id, a.file_name); }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
