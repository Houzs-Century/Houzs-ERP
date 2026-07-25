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
  { id: "mobile-language", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "houzs.mobile.lang", matches: exact("houzs.mobile.lang") },
  { id: "data-table-layout", classification: "DEVICE_PREF", storage: ["localStorage"], keyFamily: "dt:<part>:<table family>", matches: prefix("dt:") },
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
  "lib/query-persist.ts",
  "lib/rememberedEmail.ts",
  "lib/assrListFilter.ts",
  "lib/scmHandoffStorage.ts",
  "lib/scmListReturn.ts",
  "lib/workspaceTabs.ts",
  "mobile/mobileI18n.ts",
  "mobile/MobileSalesOrders.tsx",
  "mobile/useIsMobile.ts",
  "pages/MailCenter/mail-local.ts",
  "pages/MailCenter/mail-prefs.ts",
  "pages/scm-v2/ProductModels.tsx",
  "pages/scm-v2/SoFromProducts.tsx",
  "pages/scm-v2/SupplierDetail.tsx",
  "vendor/scm/components/dataGridLayoutStorage.ts",
] as const;
