import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Wrench } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { LookupManager } from "../components/LookupManager";
import { TabStrip } from "../components/TabStrip";
import { ServiceLeadTimePortal } from "./ServiceLeadTimePortal";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { UserMultiSelect } from "../components/UserMultiSelect";

interface ServiceSettingsResponse {
  default_assignee_id: number | null;
  default_assignee_name: string | null;
  default_assignee_email: string | null;
  default_assignee2_id: number | null;
  default_assignee2_name: string | null;
  default_assignee2_email: string | null;
}

interface UserOption {
  id: number;
  name: string | null;
  email: string;
}

/**
 * Service Maintenance — admin home for the QMS module. Mirrors the
 * Project Maintenance pattern: pickers, defaults, and rate cards
 * consolidated under one page so config doesn't scatter.
 *
 * Mounted as a sub-view of /assr (Quality Management → Service
 * Maintenance sidebar entry). Surfaces:
 *   - Default case assignee
 *   - Issue Categories (mig 065 lookup)
 *   - Resolution Methods (mig 065 lookup)
 *   - Priorities (mig 065 lookup, with optional SLA hours)
 *   - Issue Categories (mig 065 lookup, formerly "NCR")
 */
type SettingsTab = "general" | "lead_time";

export function ServiceSettingsView() {
  // Tab state in the URL so the back button + sidebar deep-links work.
  // ?view=settings stays — &tab=... drives the sub-tab.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab");
  const tab: SettingsTab = rawTab === "lead_time" ? "lead_time" : "general";
  function setTab(next: SettingsTab) {
    const p = new URLSearchParams(params);
    if (next === "general") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Service"
        title="Service Maintenance"
        description="Module defaults, picker lists that drive the case form, and the Lead Time Portal — manager-editable per-stage SLA targets."
      />

      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "general", label: "General" },
          { value: "lead_time", label: "Lead Time" },
        ]}
      />

      {tab === "general" && <GeneralTab />}
      {tab === "lead_time" && <ServiceLeadTimePortal />}
    </div>
  );
}

function GeneralTab() {
  return (
    <>
      <DefaultAssigneeSection />

      {/* Two-up grid on wide screens, single column on narrow. Same
          packing pattern as Project Maintenance keeps the page tight. */}
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <LookupManager
          apiPath="/api/assr/lookups/issue-categories"
          title="Issue Categories"
          description="Free-form list of complaint types (e.g. fabric tear, frame defect). Used in the case form's Issue Category dropdown."
        />
        <LookupManager
          apiPath="/api/assr/lookups/resolution-methods"
          title="Resolution Methods"
          description="How the case was resolved — replace, repair, on-site service, etc. Stored on each case as the slug; renaming is safe."
        />
        <LookupManager
          apiPath="/api/assr/lookups/priorities"
          title="Priorities"
          description="Drives the priority dot + auto-computed SLA deadline on each case. The SLA Hours column overrides the default per-priority SLA window."
          extra={{ key: "sla_hours", addLabel: "SLA hrs", rowTitle: "SLA window in hours; blank = use module default", placeholder: "—" }}
        />
        <LookupManager
          apiPath="/api/assr/lookups/product-categories"
          title="Product Categories"
          description="Mirrors AutoCount's item groups — the create-case form's Product Category dropdown. Maintained here until the AutoCount reconnect back-fills the authoritative list."
        />
        <LookupManager
          apiPath="/api/assr/lookups/ncr-categories"
          title="Root-Cause Classifications"
          description="Quality root-cause tags used on closed cases for Pareto reporting (material defect, transit damage, installation, etc.)."
        />
      </div>
    </>
  );
}

// ── Default assignee ────────────────────────────────────────────

function DefaultAssigneeSection() {
  const toast = useToast();
  // OFF-NOT-HIDE: ServiceCases.tsx no longer mounts this view without
  // `service_cases.manage`, so this is the query layer of the same gate rather
  // than a second rule. It matters because the read is the ONE thing the server
  // does not stop: GET /api/assr/settings needs only `service_cases.read`
  // (assr.ts:218) while the nav entry and the PUT both need `.manage` — so
  // anyone who could read a case could read this config. Never fire it without
  // the permission the page is actually for.
  const { can } = useAuth();
  const canManageService = can("service_cases.manage");
  const settings = useQuery<ServiceSettingsResponse>("/api/assr/settings",
    () => api.get("/api/assr/settings"),
    [],
    { enabled: canManageService }
  );
  const [saving, setSaving] = useState(false);

  // One picker, two slots: first pick = primary assignee, second =
  // co-assignee. Removing the first promotes the second.
  async function setDefaults(ids: number[]) {
    setSaving(true);
    try {
      await api.put("/api/assr/settings", {
        default_assignee_id: ids[0] ?? null,
        default_assignee2_id: ids[1] ?? null,
      });
      settings.reload();
      toast.success(ids.length ? "Default assignees updated" : "Default assignees cleared");
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const selectedIds = [
    settings.data?.default_assignee_id,
    settings.data?.default_assignee2_id,
  ].filter((n): n is number => n != null);

  // Resolve the selected chips from the settings payload itself (it carries the
  // assignee names/emails), so the picker no longer needs the full users list —
  // it self-fetches its dropdown via server typeahead.
  const selectedItems: UserOption[] = [
    settings.data?.default_assignee_id != null
      ? {
          id: settings.data.default_assignee_id,
          name: settings.data.default_assignee_name,
          email: settings.data.default_assignee_email ?? "",
        }
      : null,
    settings.data?.default_assignee2_id != null
      ? {
          id: settings.data.default_assignee2_id,
          name: settings.data.default_assignee2_name,
          email: settings.data.default_assignee2_email ?? "",
        }
      : null,
  ].filter((u): u is UserOption => u != null);

  return (
    <section className="relative overflow-visible rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        <Wrench size={12} /> Default Case Assignees
      </h2>
      <p className="mb-4 max-w-xl text-[12.5px] leading-relaxed text-ink-secondary">
        New service cases are automatically assigned to these people on
        creation — the first pick is the primary assignee, the second the
        co-assignee. Change at any time — existing cases keep whoever they
        were assigned to.
      </p>
      {settings.loading && (
        <div className="text-[12px] text-ink-muted">Loading…</div>
      )}
      {settings.data && (
        <div className="max-w-xl">
          <UserMultiSelect
            value={selectedIds}
            selectedItems={selectedItems}
            onChange={setDefaults}
            max={2}
            placeholder="Search people — no default means cases stay unassigned"
            disabled={saving}
          />
        </div>
      )}
    </section>
  );
}
