import { SCM_HANDOFF_KEYS, SCM_HANDOFF_VERSION } from "./scmHandoffStorage";

export type BrowserStorageClassification =
  | "AUTH"
  | "IDENTITY_PREF"
  | "DEVICE_PREF"
  | "CACHE"
  | "TRANSIENT"
  | "DRAFT_UI";

export type BrowserStorageKind = "localStorage" | "sessionStorage";

type StorageKeyRegistration = {
  id: string;
  classification: BrowserStorageClassification;
  storage: readonly BrowserStorageKind[];
  keyFamily: string;
  matches: (key: string) => boolean;
};

const exact = (candidate: string) => (key: string) => key === candidate;
const prefix = (candidate: string) => (key: string) => key.startsWith(candidate);
const IDENTITY_PREFERENCE_BASES = [
  "announcements:",
  "assr:",
  "houzs-mail-prefs:",
  "houzs:assistant-launcher-pos",
  "notifications:",
  "pp:",
  "projects:",
  "sidebar:",
  "team:",
] as const;

const identityPreference = (key: string): boolean => {
  const match = /^(.*):u\d+:c\d+$/.exec(key);
  return !!match && IDENTITY_PREFERENCE_BASES.some((base) => match[1].startsWith(base));
};
const SCM_TRANSIENT_KEYS = new Set(
  SCM_HANDOFF_KEYS
    .filter((key) => !key.endsWith("PaymentRetry"))
    .map((key) => `houzs:scm-handoff:v${SCM_HANDOFF_VERSION}:${key}`),
);

/**
 * Registry of browser-storage ownership. This deliberately classifies existing
 * layout keys without migrating them; changing a physical key is a separate UX
 * decision because it resets a user's table layout.
 */
export const BROWSER_STORAGE_KEY_REGISTRY: readonly StorageKeyRegistration[] = [
  { id: "auth-token", classification: "AUTH", storage: ["localStorage", "sessionStorage"], keyFamily: "auth:token", matches: exact("auth:token") },
  { id: "auth-pass", classification: "AUTH", storage: ["localStorage", "sessionStorage"], keyFamily: "auth:pass (session pass, mirrors auth:token store)", matches: exact("auth:pass") },
  { id: "auth-local-suppression", classification: "AUTH", storage: ["sessionStorage"], keyFamily: "auth:local-token-suppressed", matches: exact("auth:local-token-suppressed") },
  { id: "active-company", classification: "AUTH", storage: ["localStorage", "sessionStorage"], keyFamily: "houzs.activeCompanyId.v2 (durable, keyed u<user>) + houzs.activeCompanyId.tab (this tab) + pre-v2 ownerless keys, cleanup only", matches: prefix("houzs.activeCompanyId") },
  { id: "remembered-login", classification: "AUTH", storage: ["localStorage"], keyFamily: "houzs:login:lastEmail:v1 (+ legacy aliases)", matches: (key) => ["houzs:login:lastEmail:v1", "auth:lastEmail", "houzs_remember_email"].includes(key) },
  { id: "mail-drafts", classification: "DRAFT_UI", storage: ["localStorage"], keyFamily: "houzs-mail-local:v1|v2:u<user>:c<company>", matches: (key) => key === "houzs-mail-local:v1" || key.startsWith("houzs-mail-local:v2:") },
  { id: "payment-retry-handoffs", classification: "DRAFT_UI", storage: ["localStorage"], keyFamily: "houzs:scm-handoff:v<version>:(so|si)PaymentRetry:u<user>:c<company>:<document>", matches: (key) => /^houzs:scm-handoff:v\d+:(?:so|si)PaymentRetry:u\d+:c\d+:.+$/.test(key) },
  { id: "scm-handoffs", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs:scm-handoff:v<version>:<registered non-payment handoff>", matches: (key) => SCM_TRANSIENT_KEYS.has(key) },
  { id: "query-snapshots", classification: "CACHE", storage: ["localStorage"], keyFamily: "houzs-rq-snapshot:<build>:<session>:<company>", matches: prefix("houzs-rq-snapshot:") },
  { id: "chunk-recovery", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "chunk-recovered-at", matches: exact("chunk-recovered-at") },
  { id: "chunk-action-reload", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "chunk-action-reload (cooldown for the print-action stale-chunk reload)", matches: exact("chunk-action-reload") },
  { id: "chunk-print-resume", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "chunk-print-resume (the print to reopen after that reload)", matches: exact("chunk-print-resume") },
  { id: "workspace-tabs", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.workspaceTabs.v1 (per-window strip; blob records its {user,company} owner)", matches: exact("houzs.workspaceTabs.v1") },
  { id: "scm-list-return", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.scmListReturn.v1 (per-section last filtered list URL, for detail Back)", matches: exact("houzs.scmListReturn.v1") },
  { id: "event-commission-view", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.eventCommission.v1 (Event Commission's view, brand and open fairs, kept for Back)", matches: exact("houzs.eventCommission.v1") },
  { id: "scm-list-focus", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.scmListFocus.v1 (per-section row last opened from a list, scrolled back to on return)", matches: exact("houzs.scmListFocus.v1") },
  // Peter 2026-10-14: the desktop Projects list saves <main>'s scrollTop when a
  // row opens and restores it on detail Back — same detail-Back shape as
  // scm-list-return above. Written then consumed; no identity/company data.
  { id: "projects-list-scroll", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "projects:listScroll (desktop list scroll position, for detail Back)", matches: exact("projects:listScroll") },
  { id: "return-scroll", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.returnScroll.v1 (where a page was scrolled when a document was opened from it, per address, taken once on return; last 20, 30 minutes)", matches: exact("houzs.returnScroll.v1") },
  // Owner 2026-11-10 (bank reconciliation: 点开后也可以返回这里): the movement ids and
  // journal numbers a page had ticked when an order was opened from it, given back once
  // on return — ids and document numbers only, no identity data.
  { id: "return-picks", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.returnPicks.v1 (what a page had ticked when a document was opened from it, per address, taken once on return; last 20, 30 minutes)", matches: exact("houzs.returnPicks.v1") }, // gitleaks:allow — a sessionStorage key's name, not a credential
  { id: "project-overview-scroll", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.projectOverview.scroll (where a project's Back goes — the Projects address it was opened from — and the Project Overview page + table scroll per address, given back once; last 20 entries, 30 minutes)", matches: exact("houzs.projectOverview.scroll") },
  { id: "assr-list-filter", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.assrListFilter.v1 (per-tab Service Cases search + stage, for detail Back)", matches: exact("houzs.assrListFilter.v1") },
  // Owner 2026-08-24: "i want make it my filter didnt close until i manually
  // clear filter or close erp then filter will auto clear". Session-scoped for
  // exactly that reason — it survives opening a project and coming back, and
  // dies with the tab — the same shape scm-list-return and assr-list-filter
  // above already use for their detail-Back. It was localStorage (an
  // IDENTITY_PREF), which kept last week's filters alive on the next login.
  // The legacy localStorage copies are cleaned up by useStickyFilters.
  { id: "list-filters", classification: "TRANSIENT", storage: ["localStorage", "sessionStorage"], keyFamily: "filters:<page>:u<user>:c<company> (per-tab list/calendar filters. Plain snapshot string; OR, for idle-TTL scopes like projects-calendar / mobile-calendar, a {v,t} blob dropped 1h after the last change — owner 2026-09-30. Cleared outright on logout. localStorage listed for cleanup of the pre-2026-08-24 copies only)", matches: (key) => /^filters:.+:u\d+:c\d+$/.test(key) },
  { id: "mobile-mode-override", classification: "TRANSIENT", storage: ["localStorage", "sessionStorage"], keyFamily: "hz_force_mobile (session + legacy local cleanup)", matches: exact("hz_force_mobile") },
  { id: "legacy-notification-preference", classification: "TRANSIENT", storage: ["localStorage"], keyFamily: "notifications:browserPush (ownerless cleanup only)", matches: exact("notifications:browserPush") },
  { id: "scan-toast-acks", classification: "TRANSIENT", storage: ["localStorage"], keyFamily: "houzs:scan-draft-acked:u<user>:c<company>", matches: prefix("houzs:scan-draft-acked:") },
  // "I have seen today's pending-work reminder" (owner 2026-09-09). The DATE is
  // part of the key, which is the whole mechanism: tomorrow's key does not
  // exist yet, so the reminder returns by itself with no cron to run and
  // nothing to reset. localStorage, not session — acknowledging it must
  // survive a refresh, or the modal would reappear all day.
  { id: "pending-reminder-acks", classification: "TRANSIENT", storage: ["localStorage"], keyFamily: "pending-reminder:u<user>:c<company>:<YYYY-MM-DD>", matches: (key) => /^pending-reminder:u\d+:c\d+:\d{4}-\d{2}-\d{2}$/.test(key) },
  { id: "identity-preferences", classification: "IDENTITY_PREF", storage: ["localStorage"], keyFamily: "<approved preference base>:u<user>:c<company>", matches: identityPreference },
  { id: "pwa-dismissals", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "pwa:<surface>:dismissed-at", matches: prefix("pwa:") },
  // Native-app opt-ins, per DEVICE and per install. Currently just the
  // biometric-session flag (native:biometric-session) that gates unlocking a
  // Keychain-held session with Face ID. NOT identity data: it stores whether the
  // feature is on for this handset, never who is signed in — the session itself
  // lives in the iOS Keychain, not here.
  { id: "native-app-opt-ins", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "native:<feature>", matches: prefix("native:") },
  // The Finance report opened last in this tab (batch 6 §1.1): the sidebar's one
  // Reports entry goes back to it. The report's sidebar address, no identity data.
  { id: "finance-report-last", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "fin-reports-last", matches: exact("fin-reports-last") },
  // The Finance report list pinned open (owner's redesign, batch 6 §4.1; the
  // design's own key) — '1'/'0', a per-device layout preference.
  { id: "finance-report-list-pin", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "fin-reports-rail-pinned", matches: exact("fin-reports-rail-pinned") },
  // The last date range picked on a Finance report in this tab (batch 6 §4.3):
  // a report opened with no dates in its address follows it. {from,to} ISO days.
  { id: "finance-report-range", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "fin-report-range", matches: exact("fin-report-range") },
  // The statement column widths a person dragged, per view (batch 6 §4.1; the
  // design's own key) — px for the account column, Total and the periods.
  { id: "finance-statement-widths", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "fin-reports-colw-v2", matches: exact("fin-reports-colw-v2") },
  // A Finance table's layout a person set (owner 2026-11-05, FinanceGrid): column
  // widths, order, hidden and frozen columns, one key per table. No identity data.
  { id: "finance-grid-layout", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "fin-grid-v1:<table>", matches: prefix("fin-grid-v1:") },
  { id: "mobile-language", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "houzs.mobile.lang", matches: exact("houzs.mobile.lang") },
  { id: "theme", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "houzs.theme (light / dark / system, read before first paint by index.html too)", matches: exact("houzs.theme") },
  // Floating Assistant panel size — a per-device layout preference (width/height
  // of the draggable chat card), no identity/company data, same class as the
  // ResizableDrawer panel widths.
  { id: "assistant-panel-size", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "houzs:assistant-panel-w | houzs:assistant-panel-h", matches: (key) => key === "houzs:assistant-panel-w" || key === "houzs:assistant-panel-h" },
  { id: "data-table-layout", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "dt:<part>:<table family>", matches: prefix("dt:") },
  // Option B delivery side map (2026-08-08): whether the map panel is open or
  // collapsed on each arrangement page — a per-device layout preference, same
  // class as the panel- widths. No identity/company data (the value is '0'/'1').
  { id: "delivery-map-open", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "dmap-open.<page>.v1", matches: prefix("dmap-open.") },
  // Option B compact-columns DEFAULT (2026-08-08 amendment): whether the board
  // auto-narrows to the essential columns while the side map is open — a
  // per-device layout preference the user can toggle off (and any explicit
  // Columns-panel choice switches it off). Same class as dmap-open; '0'/'1'.
  { id: "delivery-map-compact-columns", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "dmap-compact.<page>.v1", matches: prefix("dmap-compact.") },
  // The Finance grids' dragged column widths (owner's redesign, batch 6 §1.3:
  // Journal entries, General ledger, Merchant charges, Collection) — an array
  // of px per column. A layout preference; no identity/company data.
  { id: "finance-column-widths", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "fin-<grid>-cw", matches: (key) => /^fin-[a-z]+-cw$/.test(key) },
  {
    id: "grid-and-panel-layout",
    classification: "DEVICE_PREF",
    storage: ["localStorage"],
    keyFamily: "approved DataGrid/layout families",
    matches: (key) =>
      key.startsWith("dg-") ||
      key.startsWith("panel-") ||
      /^(?:so|cn|crn|delivery-planning|pc-order|pc-receive|pc-return)-drilldown-grid\.v1$/.test(key) ||
      /^(?:do|dr|si)-detail-listing-grid$/.test(key) ||
      key === "so-detail-listing-grid.v2.houzs" ||
      /^(?:so-amendment-list|pr-g\.[a-z0-9-]+|grn-from-po|pv-list|pc-(?:order|receive|return)-list|po-from-so|cn-g\.cn-from-order-lines|cr-g\.cr-from-note-lines|pcr-g\.pcr-from-order-lines|pcrn-g\.pcrn-from-receive-lines)\.layout\.v1$/.test(key),
  },
] as const;

export function classifyBrowserStorageKey(
  key: string,
  storage?: BrowserStorageKind,
): StorageKeyRegistration | undefined {
  return BROWSER_STORAGE_KEY_REGISTRY.find(
    (entry) => (!storage || entry.storage.includes(storage)) && entry.matches(key),
  );
}

/** Files allowed to access browser storage directly. New callers require an
 * explicit ownership review; consumers should otherwise use existing helpers. */
export const PRODUCTION_STORAGE_CALLERS = [
  // Logout sweeps `filters:*` from session + localStorage (owner 2026-09-30) —
  // a reload does not clear sessionStorage, so sign-out would otherwise keep the
  // sticky list/calendar filters. Removes by key in a loop, never .clear().
  "auth/AuthContext.tsx",
  "components/AndroidInstallGuide.tsx",
  "components/announcementLocalAcks.ts",
  "components/AssistantLauncher.tsx",
  // Floating Assistant panel: persists ONLY its own width/height (DEVICE_PREF,
  // assistant-panel-size family) — a layout preference, no identity/company data.
  "components/AssistantPanel.tsx",
  "components/assistantLauncherPosition.ts",
  "components/DataTable.tsx",
  // `dt:funnels:<idKey>` — funnels a persistFilters="always" table keeps (the
  // delivery boards, owner 2026-10-05); the dt: device-pref family above.
  "components/dataTableColFilterMemory.ts",
  "components/IosInstallGuide.tsx",
  "components/PwaBanners.tsx",
  "components/pwaDismissal.ts",
  // Generic resizable slide-over: persists ONLY its chosen width (a DEVICE_PREF
  // under the panel- family) per caller-supplied storageKey. No identity/company
  // data — the key is a layout preference, same class as the DataGrid layouts.
  "components/ResizableDrawer.tsx",
  // Shared CHROME for the SCM record detail drawers (SO/PO/GRN/PI/DO/DR/PR/SI):
  // persists ONLY the one shared drawer width under panel-scm-detail-drawer.v1,
  // same DEVICE_PREF layout class as ResizableDrawer above.
  "components/ResizableDetailDrawer.tsx",
  // Option B delivery side map: persists ONLY its open/collapsed flag and the
  // compact-columns default per page (dmap-open.<page>.v1 /
  // dmap-compact.<page>.v1, both DEVICE_PREF) — layout preferences, no
  // identity or company data, same class as the ResizableDrawer widths.
  "components/scm-v2/DeliveryMapPanel.tsx",
  "components/RouteFallback.tsx",
  // The banner's local-ack memo moved into the shared hook (desktop + mobile
  // pop-ups answer "have I seen this?" the same way); AnnouncementBanner.tsx is
  // presentation only and no longer touches storage.
  "components/useAnnouncementBanner.ts",
  "hooks/useIdentityPreference.ts",
  // Mobile calendar's non-URL filters (brand/section/organizer): sessionStorage
  // under the shared filters: family, 1h idle TTL (list-filters rule).
  "hooks/useIdleSessionFilter.ts",
  "hooks/useLocalStorage.ts",
  "hooks/usePendingReminder.ts",
  "hooks/useStickyFilters.ts",
  "lib/activeCompany.ts",
  "lib/authToken.ts",
  "lib/browserNotificationPreference.ts",
  // chunk-action-reload + chunk-print-resume (sessionStorage, TRANSIENT): the
  // cooldown and the print to reopen after a stale-build reload.
  "lib/chunkActionRecovery.ts",
  // Native app: reads/writes ONLY the per-device biometric opt-in flag
  // (native:biometric-session, DEVICE_PREF). The session it unlocks lives in the
  // iOS Keychain, never in browser storage — this file touches localStorage for
  // the on/off switch and nothing else.
  "lib/nativeSession.ts",
  // native:push-token — the APNs device token last registered from this phone,
  // remembered ONLY so logout can delete the server row. Same native:<feature>
  // family; not a secret (an APNs token is useless without our provider key).
  "lib/nativePush.ts",
  "lib/query-persist.ts",
  "lib/rememberedEmail.ts",
  "lib/assrListFilter.ts",
  "lib/scmHandoffStorage.ts",
  "lib/scmListReturn.ts",
  // One-shot cleanup of the dt:sort:* keys a bug made permanent (2026-08-05).
  // Only REMOVES those, plus its own marker so it never runs twice; it writes no
  // preference of its own and reads nothing else.
  "lib/staleSortReset.ts",
  // Server-stored column layouts. Writes the SAME dt:* device-pref keys
  // DataTable owns (plus a dt:sync:* marker in that family) so a table renders
  // the account's saved layout on the first paint. Column keys only — no
  // identity data, and the company comes from the request, never from storage.
  "lib/tableLayouts.ts",
  // Light / dark / auto, per browser (owner 2026-11-11 dark mode).
  "lib/theme.ts",
  "lib/workspaceTabs.ts",
  "mobile/mobileI18n.ts",
  "mobile/MobileSalesOrders.tsx",
  "mobile/useIsMobile.ts",
  "pages/MailCenter/mail-local.ts",
  "pages/MailCenter/mail-prefs.ts",
  // Projects list scroll memory for detail Back (projects-list-scroll family).
  "pages/Projects.tsx",
  // Project Overview: where the page and its project table were scrolled when a
  // project was opened, given back on Back (project-overview-scroll, owner
  // 2026-10-21). Scroll offsets only; the choices themselves live in the URL.
  "pages/projects/projectOverviewView.ts",
  // Return scroll (return-scroll, owner 2026-10-21): where a page was scrolled
  // when an order was opened from it, so its Back lands on the same spot.
  "lib/returnScroll.ts",
  // Composer draft autosave (2026-09-05): "announcements:draft:u<user>",
  // written debounced while a notice is being written, cleared on post. A
  // half-written notice surviving a closed modal / reload is the point; the
  // key is per user so a shared browser never shows one person's draft to the
  // next. Reviewed with the announcements redesign.
  "pages/announcements/ComposerModal.tsx",
  // Finance grid column widths (finance-column-widths, fin-<grid>-cw): reads,
  // writes and removes its own key only — px per column, no identity data.
  "pages/scm-v2/finance/useColumnWidths.ts",
  // The report opened last (finance-report-last), for the sidebar's Reports entry.
  "pages/scm-v2/reports/lastReport.ts",
  // Event Commission's view, brand and open fairs (event-commission-view), kept
  // for Back: reads and writes its own sessionStorage key only, no identity data.
  "pages/scm-v2/EventCommission.tsx",
  "pages/scm-v2/ProductModels.tsx",
  "pages/scm-v2/SoFromProducts.tsx",
  "pages/scm-v2/SupplierDetail.tsx",
  // The Finance reports' own memory (finance-report-list-pin, finance-report-
  // range, finance-statement-widths): the list's pin, the last range picked and
  // the statement column widths — no identity data.
  "pages/scm-v2/reports/reportPrefs.ts",
  "vendor/scm/components/dataGridLayoutStorage.ts",
] as const;
