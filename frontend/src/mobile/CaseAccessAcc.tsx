import { api } from "../api/client";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useChoice } from "../vendor/scm/components/ChoiceDialog";

const INK = "#11140f";
const TEAL_DK = "#0c3f39";
const BROWN = "#a16a2e";

/**
 * Access — Nth-person visibility (owner 2026-09-09), mobile. Grants extra staff
 * read access WITHOUT touching sales_agent or the two assigned_to slots. Lives in
 * its own component so MobileServiceCase.tsx does not grow past its size ceiling;
 * it renders its own `pacc` accordion (global CSS, same as the file's `Acc`) so it
 * needs nothing exported from the parent. `busy` / `runWrite` are the parent's
 * single write-gate; `assignableUsers` is the parent's already-loaded picker list.
 */
export function CaseAccessAcc({
  caseId,
  access,
  busy,
  runWrite,
  assignableUsers,
}: {
  caseId: number;
  access: any[];
  busy: boolean;
  runWrite: (fn: () => Promise<void>, failTitle: string) => Promise<void>;
  assignableUsers: { id: number; name: string }[];
}) {
  const confirm = useConfirm();
  const notify = useNotify();
  const choose = useChoice();
  const accessRows: any[] = Array.isArray(access) ? access : [];

  const grantAccess = async () => {
    if (busy) return;
    const have = new Set(
      accessRows.map((a) => Number(a.user_id ?? a.userId)).filter(Boolean),
    );
    const opts = assignableUsers.filter((u) => !have.has(u.id));
    if (!opts.length) {
      await notify({ title: "No one to add", body: "Everyone available already has access." });
      return;
    }
    const picked = await choose({
      title: "Grant access",
      body: "Give someone read access to this case. Does not change the Salesperson or PIC.",
      options: opts.map((u) => ({ value: String(u.id), label: u.name })),
    });
    if (picked == null || picked === "") return;
    await runWrite(async () => {
      await api.post(`/api/assr/${caseId}/access`, { user_id: Number(picked) });
    }, "Couldn't grant access");
  };

  const revokeAccess = async (uid: number, name: string) => {
    if (busy) return;
    if (!(await confirm({ title: `Remove ${name}'s access?`, confirmLabel: "Remove", danger: true }))) return;
    await runWrite(async () => {
      await api.del(`/api/assr/${caseId}/access/${uid}`);
    }, "Couldn't remove access");
  };

  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Access</span>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: INK }}>
          {accessRows.length ? `${accessRows.length}` : "None"}
        </span>
        <span style={{ marginLeft: 8, display: "inline-flex" }}>
          <span
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) grantAccess(); }}
            className="tinybtn"
            style={{ color: BROWN, opacity: busy ? 0.5 : 1 }}
          >
            Add
          </span>
        </span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {accessRows.length === 0 ? (
          <div style={{ fontSize: 12, color: "#8a8f98", padding: "2px 0" }}>
            No extra access. Salesperson and PIC keep their own access.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {accessRows.map((a) => {
              const uid = Number(a.user_id ?? a.userId);
              const name = String(a.user_name ?? a.userName ?? `#${uid}`);
              return (
                <span
                  key={uid}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: TEAL_DK, background: "#e1efed", borderRadius: 7, padding: "4px 8px 4px 10px" }}
                >
                  {name}
                  <span
                    onClick={() => { if (!busy) revokeAccess(uid, name); }}
                    style={{ cursor: "pointer", opacity: busy ? 0.5 : 0.7, fontWeight: 700 }}
                    aria-label={`Remove ${name}`}
                  >
                    ×
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
