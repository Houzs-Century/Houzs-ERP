import { useEffect, useRef, useState } from "react";
import { Building2, Database, ImageIcon, Mail, Send, Trash2, Upload } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { pageSizePreference, useIdentityPreference } from "../hooks/useIdentityPreference";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { invalidate } from "../api/cache";
import { relativeTime } from "../lib/utils";
import {
  type Branding,
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  defaultBrandingForCompany,
  hostDefaultCompanyCode,
  normalizeBranding,
  setBrandingCache,
} from "../lib/branding";
import type { SyncStatusResponse, Paginated, ExecutionLog } from "../types";
import { correlatedFetch } from "../lib/requestCorrelation";

type SettingsTab = "connection" | "sync" | "email" | "branding" | "logs";

const SETTINGS_KEYS = ["tab"] as const;

/**
 * Settings page — split into four tabs so each section owns its own
 * surface instead of stacking as a long scroll. Connection and Sync
 * share the `/api/sync/status` fetch, hoisted to the wrapper so both
 * tabs see the same state. Email and Activity Log are self-contained.
 */
export function Settings() {
  const [params, setParams] = useStickyFilters("settings", SETTINGS_KEYS);

  const raw = params.get("tab") as SettingsTab | null;
  const active: SettingsTab =
    raw && ["connection", "sync", "email", "branding", "logs"].includes(raw)
      ? raw
      : "connection";

  function setTab(next: SettingsTab) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  const status = useQuery<SyncStatusResponse>("/api/sync/status", () => api.get("/api/sync/status"));

  const tabs: TabOption<SettingsTab>[] = [
    { value: "connection", label: "Connection" },
    { value: "sync", label: "Sync" },
    { value: "email", label: "Email" },
    { value: "branding", label: "Branding" },
    { value: "logs", label: "Activity Log" },
  ];

  const TAB_HEADER: Record<
    SettingsTab,
    { title: string; description: string }
  > = {
    connection: {
      title: "Connection",
      description: "Verify the Worker can reach the AutoCount middleware.",
    },
    sync: {
      title: "Sync",
      description: "Cron status, error retry, and manual full refresh.",
    },
    email: {
      title: "Email Notifications",
      description: "Resend integration and per-channel toggles.",
    },
    branding: {
      title: "Company Branding",
      description:
        "The company identity printed on documents (PDF letterheads), the app chrome, and the login screen.",
    },
    logs: {
      title: "Activity Log",
      description: "Execution history across every sync and scheduled job.",
    },
  };

  return (
    <div className="max-w-4xl">
      <TabStrip<SettingsTab>
        value={active}
        onChange={setTab}
        options={tabs}
      />

      <PageHeader
        eyebrow="System · Configuration"
        title={TAB_HEADER[active].title}
        description={TAB_HEADER[active].description}
      />

      {active === "connection" && <ConnectionTab />}
      {active === "sync" && (
        <SyncTab status={status.data} onReload={() => status.reload()} />
      )}
      {active === "email" && <EmailTab />}
      {active === "branding" && <BrandingTab />}
      {active === "logs" && <ActivityLog />}

      {/* Third-party asset attribution (owner 2026-07-24: keep the Icons8
          free-licence credit rather than buy a licence). The Assistant
          launcher's robot face is Icons8's "Nolan" artwork; the free tier
          requires one visible, clickable link back to icons8.com. A quiet
          Settings footer is the standard, low-prominence home for it. */}
      <footer className="mt-10 border-t border-border-subtle pt-3 text-[11px] text-ink-muted">
        Robot icon by{" "}
        <a
          href="https://icons8.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
        >
          Icons8
        </a>
      </footer>
    </div>
  );
}

// ── Connection tab ───────────────────────────────────────────

function ConnectionTab() {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [connectionOk, setConnectionOk] = useState<boolean | null>(null);

  async function testConnection() {
    setTesting(true);
    try {
      /* A non-2xx does NOT reject fetch, so testing only the throw reported
         "Connection OK" for a server answering 500/502/404 — every failure
         except a DNS/network drop. This button is what IT presses to decide
         whether the server is the problem, so a false green sends them to
         look somewhere else. */
      const res = await correlatedFetch(`${api.baseUrl}/health`);
      if (!res.ok) {
        setConnectionOk(false);
        toast.error("Server reachable but unhealthy. Please try again shortly.");
        return;
      }
      setConnectionOk(true);
      toast.success("Connection OK");
    } catch {
      setConnectionOk(false);
      toast.error("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-muted">API URL</span>
          <span className="font-mono text-xs">{api.baseUrl || "(not set)"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-muted">Status</span>
          {connectionOk === null ? (
            <span className="text-xs text-ink-muted">Not tested</span>
          ) : connectionOk ? (
            <StatusDot variant="synced" label="Connected" />
          ) : (
            <StatusDot variant="error" label="Disconnected" />
          )}
        </div>
        <div className="pt-2">
          <Button variant="secondary" onClick={testConnection} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Sync tab (filtered cron + full refresh) ───────────────────

function SyncTab({
  status,
  onReload,
}: {
  status: SyncStatusResponse | null;
  onReload: () => void;
}) {
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  async function retryAll() {
    setRetrying(true);
    try {
      const res: any = await api.post("/api/sync/retry-errors");
      toast.success(`Retried ${res?.attempted ?? 0}, synced ${res?.synced ?? 0}`);
      onReload();
    } catch (e: any) {
      toast.error(`Retry failed: ${e?.message || e}`);
    } finally {
      setRetrying(false);
    }
  }

  async function syncAll() {
    setSyncingAll(true);
    try {
      await api.post("/api/sync/pull?mode=all");
      toast.success("Full sync complete");
      onReload();
    } catch (e: any) {
      toast.error(`Sync failed: ${e?.message || e}`);
    } finally {
      setSyncingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          Filtered (cron)
        </h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last pull</span>
            <span className="font-mono text-xs">
              {status?.last_pull
                ? `${relativeTime(status.last_pull.started_at)} (${status.last_pull.status})`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Checkpoint</span>
            <span className="font-mono text-xs">{status?.checkpoint || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Sync errors</span>
            <span className="font-mono text-xs">{status?.error_count ?? 0}</span>
          </div>
          {(status?.error_count ?? 0) > 0 && (
            <div className="pt-2">
              <Button variant="danger" onClick={retryAll} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry All Errors"}
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-1 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">Full Refresh</h2>
        <p className="mb-4 text-xs text-ink-muted">
          Calls <span className="font-mono">/SalesOrder/getAll</span> and upserts
          everything — ignores server-side Remark2/Attention/Remark4/
          SalesExemptionExpiryDate filters. No checkpoint; the entire list is
          re-fetched each run. Manual only — not on the cron.
        </p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last full refresh</span>
            <span className="font-mono text-xs">
              {status?.last_pull_all
                ? `${relativeTime(status.last_pull_all.started_at)} (${status.last_pull_all.status})`
                : "Never"}
            </span>
          </div>
          <div className="pt-2">
            <Button
              variant="secondary"
              icon={<Database size={14} />}
              onClick={syncAll}
              disabled={syncingAll}
            >
              {syncingAll ? "Syncing…" : "Sync All (unfiltered)"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Email tab ────────────────────────────────────────────────

interface EmailSettingsResponse {
  settings: Record<string, { value: boolean }>;
  has_api_key: boolean;
  from: string | null;
  public_url: string | null;
}

const EMAIL_TOGGLES: { key: string; label: string; description: string }[] = [
  { key: "email.enabled", label: "Master switch", description: "When off, every channel is muted regardless of individual toggles." },
  { key: "email.assr_survey", label: "ASSR satisfaction survey", description: "Auto-send the tokenized survey link to the customer when a case closes (requires customer_email)." },
  { key: "email.assr_sla_escalation", label: "ASSR SLA breach alerts", description: "Email the assignee + managers when a case is escalated for missing its deadline >24h." },
  { key: "email.member_invite", label: "Team member invitations", description: "Email the invite / accept link when you add a staff account in User Management." },
  { key: "email.supplier_invite", label: "Supplier portal invites", description: "Email the invite / password-reset link to a supplier account." },
  { key: "email.project_due_reminder", label: "Project due reminders", description: "Daily cron emails checklist items due within 3 days or overdue." },
  { key: "email.password_reset", label: "Password reset emails", description: "Send a reset link when an admin clicks 'Send reset' on a team member." },
  { key: "email.delivery_order", label: "Delivery Order (to customer)", description: "Auto-email the customer their D.O. when an order is dispatched. Sends to real customers — keep OFF until verified and customer emails are set on orders." },
  { key: "email.invoice", label: "Invoice (to customer)", description: "Auto-email invoices to customers (trigger not built yet — leave OFF)." },
  { key: "email.document_report", label: "Report (to customer)", description: "Auto-email reports to customers (trigger not built yet — leave OFF)." },
];

function EmailTab() {
  const toast = useToast();
  const q = useQuery<EmailSettingsResponse>("/api/settings/email", () => api.get("/api/settings/email"));
  const [saving, setSaving] = useState<string | null>(null);
  const [testAddr, setTestAddr] = useState("");
  const [testing, setTesting] = useState(false);

  async function toggle(key: string, value: boolean) {
    setSaving(key);
    try {
      await api.patch<EmailSettingsResponse>("/api/settings/email", { [key]: value });
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  async function sendTest() {
    if (!testAddr.trim()) return;
    setTesting(true);
    try {
      const res = await api.post<{ status: string; reason?: string }>(
        "/api/settings/email/test",
        { to: testAddr.trim() }
      );
      if (res.status === "sent") {
        toast.success("Test email sent");
      } else {
        // Map the handful of known machine reasons to plain words; anything else
        // (including a raw provider / exception string on status "error") falls
        // back to one generic sentence, so no code or internals reaches the admin.
        const REASON_TEXT: Record<string, string> = {
          "missing or invalid recipient":
            "That email address doesn't look right. Please check it and try again.",
          "channel disabled":
            "Email sending is switched off. Turn the master switch on under Email, then try again.",
          "channel disabled at drain":
            "Email sending is switched off. Turn the master switch on under Email, then try again.",
          "RESEND_API_KEY not configured":
            "Email sending isn't set up on the server yet. Ask IT to add the email service key.",
        };
        toast.error(
          (res.reason && REASON_TEXT[res.reason]) ||
            "The test email couldn't be sent. Please check the email settings and try again.",
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setTesting(false);
    }
  }

  const s = q.data;
  return (
    <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        <Mail size={12} /> Email Notifications
      </h2>

      {q.loading && <ListSkeleton rows={4} />}

      {s && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg/60 p-3 text-[12px]">
            <StatusDot
              variant={s.has_api_key ? "synced" : "error"}
              label={s.has_api_key ? "Resend key configured" : "RESEND_API_KEY not set"}
            />
            {!s.has_api_key && (
              <span className="text-[11px] text-ink-muted">
                Set via: <span className="font-mono">wrangler secret put RESEND_API_KEY</span>
              </span>
            )}
            {s.from && (
              <span className="ml-auto text-[11px] text-ink-muted">
                From: <span className="font-mono">{s.from}</span>
              </span>
            )}
          </div>

          <div className="space-y-2">
            {EMAIL_TOGGLES.map((t) => {
              const enabled = s.settings[t.key]?.value ?? true;
              const isMaster = t.key === "email.enabled";
              const masterOff = !(s.settings["email.enabled"]?.value ?? true);
              return (
                <div
                  key={t.key}
                  className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex-1">
                    <div
                      className={`text-[12px] font-semibold ${isMaster ? "text-ink" : masterOff ? "text-ink-muted" : "text-ink"}`}
                    >
                      {t.label}
                    </div>
                    <div className="text-[11px] text-ink-muted">{t.description}</div>
                  </div>
                  <label className="mt-0.5 inline-flex cursor-pointer items-center gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={saving === t.key || (!isMaster && masterOff)}
                      onChange={(e) => toggle(t.key, e.target.checked)}
                      className="accent-accent"
                    />
                    <span className={enabled ? "text-synced" : "text-ink-muted"}>
                      {enabled ? "On" : "Off"}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>

          <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
            <input
              type="email"
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
              placeholder="you@example.com"
              className="h-8 flex-1 rounded-md border border-border bg-surface px-3 text-[12px]"
            />
            <Button
              variant="secondary"
              icon={<Send size={12} />}
              disabled={testing || !testAddr.trim() || !s.has_api_key}
              onClick={sendTest}
            >
              {testing ? "Sending…" : "Send Test"}
            </Button>
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            Test email ignores channel toggles but still requires RESEND_API_KEY.
          </div>
        </>
      )}
    </section>
  );
}

// ── Branding tab ─────────────────────────────────────────────
//
// One editable record for the company identity that used to be hardcoded
// across the PDF letterheads, the app chrome, and the login screen. Reads
// GET /api/branding, saves via PUT /api/branding behind an in-app confirm
// (no window.confirm). The save is gated to settings.manage admins; non-admins
// see the values read-only.

interface BrandingResponse {
  branding?: unknown;
  /** Active company this branding row belongs to ('HOUZS' | '2990') — the
   *  top-bar switcher IS the company selector for this tab. Absent on a
   *  pre-multi-company backend. */
  companyCode?: string | null;
}

const BRANDING_FIELDS: {
  key: keyof Branding;
  label: string;
  placeholder: string;
  hint?: string;
  optional?: boolean;
}[] = [
  { key: "companyName", label: "Company name", placeholder: "Houzs Century Sdn Bhd" },
  {
    key: "registrationNo",
    label: "SSM registration no",
    placeholder: "202201031135 (1476832-W)",
  },
  {
    key: "address",
    label: "Address",
    placeholder: "Lot / street, area, city, state.",
    hint: "Printed as the letterhead address; split onto two lines on a comma boundary. The postcode below is appended automatically if it isn't already in this text.",
  },
  {
    key: "postcode",
    label: "Postcode",
    placeholder: "43300",
    hint: "Woven into the printed letterhead address.",
  },
  { key: "phone", label: "Phone", placeholder: "011-1110 8883" },
  { key: "email", label: "Email", placeholder: "hello@houzscentury.com" },
  {
    key: "website",
    label: "Website",
    placeholder: "houzscentury.com",
    optional: true,
  },
];

/**
 * One of the two company logo slots (owner 2026-08-06).
 *
 * `app`   → logoR2Key      — what the app chrome and the login screen render.
 *                            Those surfaces are DARK, so this is normally the
 *                            light/white artwork.
 * `print` → printLogoR2Key — what document letterheads use. That's white paper,
 *                            so it is normally the dark artwork. Empty means
 *                            "print the app logo", which is what every company
 *                            did before this slot existed.
 *
 * One file genuinely can't serve both: 2990's white logo is right in the
 * sidebar and prints as a near-invisible watermark on a Delivery Order.
 */
const LOGO_SLOT_COPY = {
  app: {
    label: "Company logo",
    filled:
      "Shown in the app (sidebar, login screen). Those are dark surfaces, so use the light version. Also used on document letterheads when no print logo is set below.",
    empty:
      "No logo uploaded — the app shows the company name, and letterheads use the text-only header.",
    uploaded: "Logo uploaded — the app chrome now uses it",
    removeTitle: "Remove company logo?",
    removeMessage:
      "The app chrome falls back to the company name. Document letterheads keep using the print logo if one is set, otherwise the text-only header.",
  },
  print: {
    label: "Print logo (documents)",
    filled:
      "Printed top-left on every document letterhead (PDF and print). That's white paper, so use the dark version.",
    empty:
      "No print logo — document letterheads use the company logo above. Set one here if that logo is too light to print.",
    uploaded: "Print logo uploaded — it now prints on every document letterhead",
    removeTitle: "Remove print logo?",
    removeMessage: "Document letterheads go back to using the company logo above.",
  },
} as const;

function LogoSlot({
  variant,
  storedKey,
  canEdit,
  disabled,
  onApply,
}: {
  variant: "app" | "print";
  storedKey: string;
  canEdit: boolean;
  disabled: boolean;
  onApply: (raw: unknown) => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const copy = LOGO_SLOT_COPY[variant];
  // ?variant=print addresses the second slot; no param = the on-screen one, so
  // this collapses to the exact pre-2026-08 request for the app slot.
  const query = variant === "print" ? "?variant=print" : "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Preview is a blob URL — the serve endpoint needs the bearer, so <img src>
  // can't hit it directly (same pattern as Avatar). Keys carry a Date.now()
  // stamp, so passing the key as a query param busts stale caches.
  useEffect(() => {
    if (!storedKey) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .fetchBlobUrl(
        `/api/branding/logo${query ? `${query}&` : "?"}k=${encodeURIComponent(storedKey)}`,
      )
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          objectUrl = u;
          setUrl(u);
        }
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [storedKey, query]);

  async function upload(file: File | null) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast.error("Logo must be a PNG or JPG image");
      return;
    }
    if (file.size > 1024 * 1024) {
      toast.error("Logo must be under 1 MB");
      return;
    }
    setBusy(true);
    try {
      const res = await api.postBinary<BrandingResponse>(
        `/api/branding/logo${query}`,
        file,
        file.type,
      );
      onApply(res?.branding);
      toast.success(copy.uploaded);
    } catch (e: any) {
      toast.error(e?.message || "Failed to upload logo");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: copy.removeTitle,
      message: copy.removeMessage,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.del<BrandingResponse>(`/api/branding/logo${query}`);
      onApply(res?.branding);
      toast.success(variant === "print" ? "Print logo removed" : "Logo removed");
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove logo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
        {copy.label}
        <span className="ml-1 font-normal text-ink-muted">(optional)</span>
      </label>
      <div className="flex items-center gap-3 rounded-md border border-border bg-bg/50 px-3 py-3">
        {/* Preview each logo ON THE SURFACE IT IS FOR — the app slot against the
            dark sidebar colour, the print slot against paper white. A white
            logo previewed on a light card is invisible, which is exactly the
            confusion this whole feature exists to clear up. */}
        {url ? (
          <img
            src={url}
            alt={copy.label}
            className={`h-12 max-w-[160px] shrink-0 rounded-sm object-contain px-2 ${
              variant === "print" ? "bg-white" : "bg-sidebar"
            }`}
          />
        ) : (
          <div className="grid h-12 w-16 shrink-0 place-items-center rounded-sm border border-dashed border-border text-ink-muted">
            <ImageIcon size={16} />
          </div>
        )}
        <div className="min-w-0 flex-1 text-[11px] text-ink-muted">
          {storedKey ? copy.filled : copy.empty}
          <div className="mt-0.5">PNG or JPG, up to 1 MB.</div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                void upload(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              disabled={busy || disabled}
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={13} />
              {busy ? "Working…" : storedKey ? "Replace" : "Upload"}
            </Button>
            {storedKey && (
              <Button
                variant="secondary"
                disabled={busy || disabled}
                onClick={() => void remove()}
              >
                <Trash2 size={13} />
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BrandingTab() {
  const toast = useToast();
  const dialog = useDialog();
  const { can } = useAuth();
  const canEdit = can("settings.manage");

  const q = useQuery<BrandingResponse>("/api/branding", () => api.get("/api/branding"));
  const [form, setForm] = useState<Branding | null>(null);
  const [saving, setSaving] = useState(false);

  // Active company for this tab (echoed by GET /api/branding). Drives the
  // default set — a blank 2990 field must stay blank, never snap to a Houzs
  // literal — and the "editing <company>" hint in the header.
  const companyCode = (
    q.data?.companyCode?.trim() || hostDefaultCompanyCode()
  ).toUpperCase();
  const companyDefaults = defaultBrandingForCompany(companyCode);

  // Hydrate the editable form once the fetch lands (and on reloads).
  useEffect(() => {
    if (q.data) setForm(normalizeBranding(q.data.branding, defaultBrandingForCompany((q.data.companyCode?.trim() || hostDefaultCompanyCode()).toUpperCase())));
  }, [q.data]);

  function set<K extends keyof Branding>(key: K, value: Branding[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Apply the server-confirmed branding after a logo change: form + module
   *  cache + PDF logo memo, so the next generated PDF is immediately right. */
  function applyBranding(raw: unknown) {
    // A logo route always echoes the saved row; fall back to the current form
    // so a truncated response can never blank the fields on screen.
    const next = normalizeBranding(raw ?? form ?? {}, companyDefaults);
    setForm(next);
    setBrandingCache(next, companyCode);
    clearBrandingLogoCache();
    // postBinary (unlike api.put/del) doesn't auto-invalidate the SWR family —
    // drop /api/branding explicitly so the reload below fetches fresh.
    invalidate("/api/branding");
    q.reload();
  }

  async function save() {
    if (!form) return;
    if (!form.companyName.trim()) {
      toast.error("Company name is required");
      return;
    }
    const ok = await dialog.confirm({
      title: "Save company branding?",
      message:
        "This updates the identity printed on every document (PDF letterheads), the app chrome, and the login screen.",
      confirmLabel: "Save",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await api.put<BrandingResponse>("/api/branding", form);
      const next = normalizeBranding(res?.branding ?? form, companyDefaults);
      setForm(next);
      // Push to the module cache so PDFs generated this session use the new
      // values immediately, without waiting for a refetch.
      setBrandingCache(next, companyCode);
      q.reload();
      toast.success("Branding saved");
    } catch (e: any) {
      toast.error(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
      <h2 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
        <Building2 size={12} /> Company Identity
        {/* Which company's row this tab edits — switch companies in the top
            bar to edit the other one. */}
        <span className="rounded border border-border px-1.5 py-0.5 text-[9px] font-semibold text-ink-muted">
          {companyCode}
        </span>
      </h2>

      {q.loading && !form && <ListSkeleton rows={4} />}

      {form && (
        <div className="space-y-4">
          {BRANDING_FIELDS.map((f) => {
            const isAddress = f.key === "address";
            const value = form[f.key];
            return (
              <div key={f.key}>
                <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                  {f.label}
                  {f.optional && (
                    <span className="ml-1 font-normal text-ink-muted">(optional)</span>
                  )}
                </label>
                {isAddress ? (
                  <textarea
                    value={value}
                    disabled={!canEdit || saving}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    rows={2}
                    className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
                  />
                ) : (
                  <input
                    type="text"
                    value={value}
                    disabled={!canEdit || saving}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
                  />
                )}
                {f.hint && (
                  <div className="mt-1 text-[11px] text-ink-muted">{f.hint}</div>
                )}
              </div>
            );
          })}

          {/* Two logo slots: the app chrome is DARK and paper is WHITE, so one
              file can't serve both. The print slot is optional — blank means
              "print the app logo", the pre-2026-08 behaviour. */}
          <LogoSlot
            variant="app"
            storedKey={form.logoR2Key}
            canEdit={canEdit}
            disabled={saving}
            onApply={applyBranding}
          />
          <LogoSlot
            variant="print"
            storedKey={form.printLogoR2Key}
            canEdit={canEdit}
            disabled={saving}
            onApply={applyBranding}
          />

          {canEdit ? (
            <div className="flex items-center gap-2 border-t border-border pt-4">
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save Branding"}
              </Button>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() =>
                  setForm(q.data ? normalizeBranding(q.data.branding) : DEFAULT_BRANDING)
                }
              >
                Reset
              </Button>
            </div>
          ) : (
            <div className="border-t border-border pt-4 text-[11px] text-ink-muted">
              You don't have permission to edit branding. Ask an administrator.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Activity Log ──────────────────────────────────────────────

function ActivityLog() {
  const [type, setType] = useState("");
  const [logStatus, setLogStatus] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useIdentityPreference("pp:logs", 50, pageSizePreference([10, 25, 50, 100, 200]));

  const list = useQuery<Paginated<ExecutionLog>>("/api/logs:)}",
    () =>
      api.get(`/api/logs${buildQuery({ type, status: logStatus, page, per_page: perPage })}`),
    [type, logStatus, page, perPage]
  );

  const columns: Column<ExecutionLog>[] = [
    {
      key: "started_at",
      label: "Time",
      alwaysVisible: true,
      render: (r) => (
        <span title={r.started_at} className="font-mono text-xs text-ink-secondary">
          {relativeTime(r.started_at)}
        </span>
      ),
      getValue: (r) => r.started_at,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => (
        <span className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-secondary">
          {r.type}
        </span>
      ),
      getValue: (r) => r.type,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <StatusDot
          variant={
            r.status === "SYNCED" ? "synced" : r.status === "FAILED" ? "error" : "neutral"
          }
          label={r.status}
        />
      ),
      getValue: (r) => r.status,
    },
    {
      key: "message",
      label: "Message",
      render: (r) => <span className="text-ink-secondary">{r.message || "—"}</span>,
      getValue: (r) => r.message,
    },
    {
      key: "request_id",
      label: "ID",
      render: (r) => (
        <span className="font-mono text-[10px] text-ink-muted" title={r.request_id}>
          {r.request_id.slice(0, 8)}
        </span>
      ),
      getValue: (r) => r.request_id,
    },
  ];

  const selectClass =
    "h-8 rounded-lg border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select
          className={selectClass}
          value={type}
          onChange={(e) => {
            setPage(1);
            setType(e.target.value);
          }}
        >
          <option value="">All Types</option>
          <option value="PULL">Pull</option>
          <option value="PUSH">Push</option>
          <option value="OVERDUE">Overdue</option>
          <option value="PO">PO</option>
          <option value="ASSR">ASSR</option>
        </select>
        <select
          className={selectClass}
          value={logStatus}
          onChange={(e) => {
            setPage(1);
            setLogStatus(e.target.value);
          }}
        >
          <option value="">All Status</option>
          <option value="SYNCED">Synced</option>
          <option value="FAILED">Failed</option>
          <option value="SKIPPED">Skipped</option>
        </select>
      </div>

      <DataTable
        tableId="logs"
        udfTable="logs"
        udfTableLabel="Activity Log"
        exportName="activity-log"
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No log entries"
        getRowKey={(r) => r.id}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}

