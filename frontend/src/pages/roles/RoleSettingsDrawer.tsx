import { useState } from "react";
import { Button } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import type { Role } from "../../types";

/**
 * "Role settings" drawer — what the inline permission matrix does not cover:
 * the role's name, description and the PIC scope flag. Permission GRANTS are
 * edited on the main matrix; which pages a member sees comes from their Title
 * (Roles & Permissions › Titles). The per-role page matrix that used to live
 * here wrote role_page_access, dropped on 2026-09-17.
 */
export function RoleSettingsDrawer({
  open,
  role,
  canManage,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: Role;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isSystem = !!role.is_system;
  const readOnly = !canManage || isSystem;

  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description || "");
  const [scopeToPic, setScopeToPic] = useState<boolean>(!!role.scope_to_pic);
  const [busy, setBusy] = useState(false);

  const dirty =
    !readOnly &&
    (name.trim() !== role.name ||
      (description.trim() || "") !== (role.description || "") ||
      scopeToPic !== !!role.scope_to_pic);

  async function save() {
    if (!dirty) {
      onClose();
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/roles/${role.id}`, {
        name: name.trim(),
        scope_to_pic: scopeToPic,
        description: description.trim() || null,
      });
      toast.success(`Updated ${name.trim()}`);
      onSaved();
    } catch (e) {
      toast.error((e instanceof Error && e.message) || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={role.name}
      subtitle={isSystem ? "System role · settings are read-only" : "Role settings"}
      width={520}
      dirty={dirty}
    >
      <PanelSection title="Identity">
        <div>
          <label
            htmlFor="role-settings-name"
            className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted"
          >
            Name
          </label>
          <input
            id="role-settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        <div>
          <label
            htmlFor="role-settings-description"
            className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted"
          >
            Description
          </label>
          <textarea
            id="role-settings-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={readOnly}
            placeholder="What this role is for"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        {!isSystem && (
          <label className="flex items-start gap-2 rounded-md border border-border bg-bg/40 p-2.5">
            <input
              type="checkbox"
              checked={scopeToPic}
              disabled={readOnly}
              onChange={(e) => setScopeToPic(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
            />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-ink">
                Scope to PIC's projects
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-ink-muted">
                Users with this role only see projects where they or their manager
                is the PIC. Finance, logistics, linked trips and payment stay hidden.
              </div>
            </div>
          </label>
        )}
        <p className="mb-0 text-[11px] text-ink-secondary">
          Which pages a member sees comes from their Title — Roles &amp; Permissions, Titles tab.
          This role decides what they can do.
        </p>
      </PanelSection>

      <div className="sticky bottom-0 -mx-6 mt-4 flex justify-end gap-2 border-t border-border bg-surface px-6 py-3">
        <Button variant="ghost" onClick={onClose}>
          {dirty ? "Cancel" : "Close"}
        </Button>
        {canManage && !isSystem && (
          <Button variant="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        )}
      </div>
    </Panel>
  );
}
