import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App, { preloadRouteChunks } from "./App";
import "./index.css";
import "./vendor/design-system/tokens.css";
import "./theme.css";
import { ToastProvider } from "./hooks/useToast";
import { DialogProvider } from "./hooks/useDialog";
import { AuthProvider, primeAuthMe } from "./auth/AuthContext";
import { AuthGate, mobileShellEnabled, preloadMobileApp } from "./auth/AuthGate";
import { isMobileViewportNow } from "./mobile/useIsMobile";
import { PwaBanners } from "./components/PwaBanners";
import { NewVersionBanner } from "./components/NewVersionBanner";
import { ChunkReloadBoundary } from "./components/RouteFallback";
import { LazySlot } from "./components/LazySlot";
import { registerPwa } from "./pwa";
import { installGlobalErrorReporting } from "./lib/errorReporter";
import { installChunkFailureWatch } from "./lib/staleBuild";
import { CJK_FONT_STYLESHEET, loadDeferredFontStylesheet } from "./lib/deferredFonts";
import { clearStaleTableSorts } from "./lib/staleSortReset";
import { consumeCompanyUrlSeed } from "./lib/activeCompany";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { tokenStore } from "./api/client";
import { restoreNativeSession } from "./lib/nativeSession";
import { registerNativePush } from "./lib/nativePush";
import { readAuthToken } from "./lib/authToken";
import { canonicalRedirectUrl } from "./lib/canonicalHost";
import { appSurfaceForPath, useAppSurface } from "./routing/appSurface";

void import("./lib/theme").then((m) => m.initTheme());

// Canonical-domain guard (owner 2026-07: "我要全部看到 .houzscentury.com").
// Production also answers on the Cloudflare Pages default host
// `houzs-erp.pages.dev`; bounce those hits to `erp.houzscentury.com`,
// preserving path + query + hash. Every other origin — staging, previews,
// erp.2990shome.com, localhost — is left alone. See lib/canonicalHost.ts for
// why each exclusion is load-bearing.
//
// Runs FIRST, before registerPwa() and before React mounts, so we never
// register a service worker or boot the app on an origin we're leaving.
// `location.replace` (not `href`) keeps the dead origin out of session
// history, so Back doesn't bounce the user straight back into it.
//
// This is the belt to the Pages Function's braces: `frontend/public/_redirects`
// rewrites `/*` to the SPA shell, and per this project's field notes that rule
// is evaluated BEFORE Pages Functions — so the Function's server-side 302 may
// never run in normal operation. This client-side hop always does.
//
// NOTE the hash is carried across, so an owner "view as" link
// (`…/#login-as=<token>`) pasted against the legacy host still hands its token
// to the canonical origin — which is itself in LOGIN_AS_HOSTS below.
const canonicalTarget = canonicalRedirectUrl(window.location.href);
if (canonicalTarget) window.location.replace(canonicalTarget);

const LeaveGuardBridge = lazy(() => import("./components/LeaveGuardBridge").then((m) => ({ default: m.LeaveGuardBridge })));
const SurveyPublic = lazy(() => import("./pages/SurveyPublic").then((m) => ({ default: m.SurveyPublic })));
const PortalApp = lazy(() => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp })));
const MeetingBook = lazy(() => import("./pages/MeetingBook").then((m) => ({ default: m.MeetingBook })));
const PublicDoScan = lazy(() => import("./pages/PublicDoScan").then((m) => ({ default: m.PublicDoScan })));
const PublicDoScanBasket = lazy(() => import("./pages/PublicDoScanBasket").then((m) => ({ default: m.PublicDoScanBasketPage })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const AcceptInviteScreen = lazy(() => import("./auth/AuthScreens").then((m) => ({ default: m.AcceptInviteScreen })));
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy").then((m) => ({ default: m.PrivacyPolicy })));
const ContractorCalendar = lazy(() => import("./pages/ContractorCalendar").then((m) => ({ default: m.ContractorCalendar })));
const BrandCalendar = lazy(() => import("./pages/ContractorCalendar").then((m) => ({ default: m.BrandCalendar })));

function PublicFallback() {
  return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading</div>;
}

if (!canonicalTarget) registerPwa();

installGlobalErrorReporting();
loadDeferredFontStylesheet(document, CJK_FONT_STYLESHEET);
installChunkFailureWatch();
void import("./lib/numberInputWheel").then((m) => m.installNumberInputWheelGuard());
clearStaleTableSorts();

// Multi-window company hand-off (owner 2026-07-23): the company switcher's
// "Open in new window" opens `/?company=<id>` so the new window boots straight
// into that company — one window on Houzs, another on 2990, side by side.
// Consumed BEFORE React mounts (the seed must exist before AuthProvider's
// /auth/me fires the first authed requests) and BEFORE the SSO block below,
// whose replaceState would discard the query string. Scrubs the parameter;
// this tab's sessionStorage owns the answer from here.
consumeCompanyUrlSeed();

// View-as hand-off (owner 2026-07-17): the owner's local "Portal Viewer"
// launcher opens this app with #login-as=<token> so they can hop between
// accounts in one click while reviewing the portal. On staging the launcher
// logs into shared-password test accounts; on production it uses the
// owner-only POST /users/:id/impersonate (1-hour tokens, audited). Consume
// the token BEFORE React boots, store it session-only (never "remember me"),
// and scrub it from the URL/history. NOTE this hook mints nothing — it only
// stores a token the API already issued to an authorised caller.
const LOGIN_AS_HOSTS = new Set([
  "houzs-erp-staging.pages.dev",
  "houzs-erp.pages.dev",
  "erp.houzscentury.com",
]);
if (LOGIN_AS_HOSTS.has(window.location.hostname)) {
  const m = /[#&]login-as=([^&]+)/.exec(window.location.hash);
  if (m) {
    tokenStore.set(decodeURIComponent(m[1]), false);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  //   https://erp.houzscentury.com/#sso=<token>&next=<path>
  const sso = /[#&]sso=([^&]+)/.exec(window.location.hash);
  if (sso) {
    tokenStore.set(decodeURIComponent(sso[1]), false);
    const next = /[#&]next=([^&]+)/.exec(window.location.hash);
    const rawNext = next ? decodeURIComponent(next[1]) : "/";
    const safeNext = /^\/(?!\/)/.test(rawNext) ? rawNext : "/";
    window.history.replaceState(null, "", safeNext);
  }
}

function RootApp() {
  const surface = useAppSurface();
  if (surface === "survey") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <SurveyPublic />
      </LazySlot>
    );
  }
  if (surface === "portal") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <PortalApp />
      </LazySlot>
    );
  }
  if (surface === "doscan") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <PublicDoScan />
      </LazySlot>
    );
  }
  if (surface === "doscanbasket") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <PublicDoScanBasket />
      </LazySlot>
    );
  }
  if (surface === "contractor") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <ContractorCalendar />
      </LazySlot>
    );
  }
  if (surface === "book") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <MeetingBook />
      </LazySlot>
    );
  }
  if (surface === "brand") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <BrandCalendar />
      </LazySlot>
    );
  }
  if (surface === "reset") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <Routes>
          <Route path="/reset/:token" element={<ResetPassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LazySlot>
    );
  }
  if (surface === "invite") {
    return (
      <AuthProvider>
        <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
          <Routes>
            <Route path="/invite/:token" element={<AcceptInviteScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </LazySlot>
      </AuthProvider>
    );
  }
  if (surface === "privacy") {
    return (
      <LazySlot resetKey={`public:${surface}`} fallback={<PublicFallback />}>
        <Routes>
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="*" element={<Navigate to="/privacy" replace />} />
        </Routes>
      </LazySlot>
    );
  }
  return (
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
      <NewVersionBanner />
    </AuthProvider>
  );
}

if (!canonicalTarget && readAuthToken() && appSurfaceForPath(window.location.pathname) === "staff") {
  primeAuthMe();
  if (mobileShellEnabled(isMobileViewportNow())) preloadMobileApp();
  else preloadRouteChunks(window.location.pathname);
}

await restoreNativeSession();

if (readAuthToken()) void registerNativePush();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChunkReloadBoundary>
    <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <ToastProvider>
       <DialogProvider>
        <RootApp />
        <LazySlot resetKey="leave-guard" fallback={null}><LeaveGuardBridge /></LazySlot>
        <PwaBanners />
       </DialogProvider>
      </ToastProvider>
    </BrowserRouter>
    </QueryClientProvider>
    </ChunkReloadBoundary>
  </React.StrictMode>
);
