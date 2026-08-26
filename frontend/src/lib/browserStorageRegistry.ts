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
  "filters:",
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
  { id: "workspace-tabs", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.workspaceTabs.v1 (per-window strip; blob records its {user,company} owner)", matches: exact("houzs.workspaceTabs.v1") },
  { id: "scm-list-return", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.scmListReturn.v1 (per-section last filtered list URL, for detail Back)", matches: exact("houzs.scmListReturn.v1") },
  { id: "assr-list-filter", classification: "TRANSIENT", storage: ["sessionStorage"], keyFamily: "houzs.assrListFilter.v1 (per-tab Service Cases search + stage, for detail Back)", matches: exact("houzs.assrListFilter.v1") },
  { id: "mobile-mode-override", classification: "TRANSIENT", storage: ["localStorage", "sessionStorage"], keyFamily: "hz_force_mobile (session + legacy local cleanup)", matches: exact("hz_force_mobile") },
  { id: "legacy-notification-preference", classification: "TRANSIENT", storage: ["localStorage"], keyFamily: "notifications:browserPush (ownerless cleanup only)", matches: exact("notifications:browserPush") },
  { id: "scan-toast-acks", classification: "TRANSIENT", storage: ["localStorage"], keyFamily: "houzs:scan-draft-acked:u<user>:c<company>", matches: prefix("houzs:scan-draft-acked:") },
  { id: "identity-preferences", classification: "IDENTITY_PREF", storage: ["localStorage"], keyFamily: "<approved preference base>:u<user>:c<company>", matches: identityPreference },
  { id: "pwa-dismissals", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "pwa:<surface>:dismissed-at", matches: prefix("pwa:") },
  // Native-app opt-ins, per DEVICE and per install. Currently just the
  // biometric-session flag (native:biometric-session) that gates unlocking a
  // Keychain-held session with Face ID. NOT identity data: it stores whether the
  // feature is on for this handset, never who is signed in — the session itself
  // lives in the iOS Keychain, not here.
  { id: "native-app-opt-ins", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "native:<feature>", matches: prefix("native:") },
  { id: "mobile-language", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "houzs.mobile.lang", matches: exact("houzs.mobile.lang") },
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
  "components/AndroidInstallGuide.tsx",
  "components/announcementLocalAcks.ts",
  "components/AssistantLauncher.tsx",
  // Floating Assistant panel: persists ONLY its own width/height (DEVICE_PREF,
  // assistant-panel-size family) — a layout preference, no identity/company data.
  "components/AssistantPanel.tsx",
  "components/assistantLauncherPosition.ts",
  "components/DataTable.tsx",
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
  "hooks/useLocalStorage.ts",
  "hooks/useStickyFilters.ts",
  "lib/activeCompany.ts",
  "lib/authToken.ts",
  "lib/browserNotificationPreference.ts",
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
  "lib/workspaceTabs.ts",
  "mobile/mobileI18n.ts",
  "mobile/MobileSalesOrders.tsx",
  "mobile/useIsMobile.ts",
  "pages/MailCenter/mail-local.ts",
  "pages/MailCenter/mail-prefs.ts",
  "pages/scm-v2/ProductModels.tsx",
  "pages/scm-v2/SoFromProducts.tsx",
  "pages/scm-v2/SupplierDetail.tsx",
  // Persisted DataGrid funnel filters (dg-filters:<idKey>, DEVICE_PREF via the
  // dg- family) — the DataTable dt:filters twin. Column keys and filter values
  // only; the company scoping rides the layout idKey, never storage-read.
  "vendor/scm/components/dataGridFilterStorage.ts",
  "vendor/scm/components/dataGridLayoutStorage.ts",
] as const;
