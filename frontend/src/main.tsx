import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import "./index.css";
// Vendored 2990's brand tokens (CSS custom properties only — the global
// body/h1/table element resets from 2990's main.css are deliberately NOT
// imported, so the rest of Houzs is unaffected). Scopes via :root variables
// that the vendored /scm/* pages + design-system read from.
import "./vendor/design-system/tokens.css";
import { ToastProvider } from "./hooks/useToast";
import { DialogProvider } from "./hooks/useDialog";
import { AuthProvider } from "./auth/AuthContext";
import { AuthGate } from "./auth/AuthGate";
import { PwaBanners } from "./components/PwaBanners";
import { ChunkReloadBoundary } from "./components/RouteFallback";
import { registerPwa } from "./pwa";
import { installGlobalErrorReporting } from "./lib/errorReporter";
import { consumeCompanyUrlSeed } from "./lib/activeCompany";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { tokenStore } from "./api/client";
import { canonicalRedirectUrl } from "./lib/canonicalHost";
import { useAppSurface } from "./routing/appSurface";

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

// The public surfaces (survey, customer/supplier portal, password reset)
// are split out of the staff bundle — staff never download them, and the
// public flows skip the whole dashboard bundle in return.
const SurveyPublic = lazy(() => import("./pages/SurveyPublic").then((m) => ({ default: m.SurveyPublic })));
const PortalApp = lazy(() => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
// Invite acceptance rides in the unauthenticated-screens chunk (see
// auth/AuthGate.tsx) — same split, same reason: staff sessions never load it.
const AcceptInviteScreen = lazy(() => import("./auth/AuthScreens").then((m) => ({ default: m.AcceptInviteScreen })));

function PublicFallback() {
  return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading</div>;
}

// Register the service worker + capture installability events.
// Safe on every page (survey/portal/supplier all benefit too).
//
// Skipped when we are mid-redirect to the canonical domain: `location.replace`
// does not halt script execution, so without this guard we would install a
// service worker on the very origin we are abandoning — leaving a cached shell
// behind on `houzs-erp.pages.dev` for a host nobody should be using.
if (!canonicalTarget) registerPwa();

// Self-hosted client error reporting: window error + unhandledrejection
// listeners, batched to POST /api/client-errors. Installed BEFORE React renders
// so even a first-render crash is captured. Prod builds only; reporting never
// changes behaviour (see lib/errorReporter.ts).
installGlobalErrorReporting();

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
    // Through tokenStore, not a hand-rolled pair of storage calls: it owns the
    // persistent/session split, and open-coding it here is what let this path
    // drift. persistent=false keeps the "never remember me" intent.
    tokenStore.set(decodeURIComponent(m[1]), false);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  // POS→Houzs SSO handoff (2026-07-22): a POS button opens
  //   https://erp.houzscentury.com/#sso=<token>&next=<path>
  // where <token> came from POST /api/pos/exchange-web-session (mints a fresh
  // desktop session for the same user). Store the token session-only, jump to
  // <next>, and scrub the hash — so the salesperson lands on the Houzs page
  // (Manual SO / Service Case) already logged in, no email+password prompt.
  // Same tokenStore + `persistent: false` semantics as the login-as flow above.
  const sso = /[#&]sso=([^&]+)/.exec(window.location.hash);
  if (sso) {
    tokenStore.set(decodeURIComponent(sso[1]), false);
    const next = /[#&]next=([^&]+)/.exec(window.location.hash);
    // Safe next: same-origin path only (starts with a single '/', not '//' to
    // rule out protocol-relative). Falls back to '/' otherwise.
    const rawNext = next ? decodeURIComponent(next[1]) : "/";
    const safeNext = /^\/(?!\/)/.test(rawNext) ? rawNext : "/";
    window.history.replaceState(null, "", safeNext);
  }
}

// Public routes that must bypass the staff AuthGate entirely:
//   /survey/:token       — tokenized customer satisfaction survey
//   /track               — public case-lookup form (ASSR no + phone)
//   /portal/case/:token  — customer-facing case view scoped by token
// The selection is made from the LIVE Router location. It used to be frozen
// here at module evaluation, so navigate("/") changed the address bar but left
// reset/invite users trapped inside the old public-only route tree.
// Invitation acceptance is a real public route (/invite/:token) so the
// set-password screen works even when a session already exists (e.g. the
// owner clicking the link while logged in). It needs AuthProvider for
// acceptInvite(), but renders OUTSIDE AuthGate so a live session doesn't
// short-circuit it into the dashboard.
function RootApp() {
  const surface = useAppSurface();
  if (surface === "survey") {
    return (
      <Suspense fallback={<PublicFallback />}>
        <SurveyPublic />
      </Suspense>
    );
  }
  if (surface === "portal") {
    return (
      <Suspense fallback={<PublicFallback />}>
        <PortalApp />
      </Suspense>
    );
  }
  if (surface === "reset") {
    return (
      <Suspense fallback={<PublicFallback />}>
        <Routes>
          <Route path="/reset/:token" element={<ResetPassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    );
  }
  if (surface === "invite") {
    return (
      <AuthProvider>
        <Suspense fallback={<PublicFallback />}>
          <Routes>
            <Route path="/invite/:token" element={<AcceptInviteScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    );
  }
  return (
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Top-level boundary: any render error (in Layout, Sidebar, a provider, or
        a route) shows a friendly reload panel instead of a white screen, and
        auto-reloads once on a stale-chunk error after a deploy. */}
    <ChunkReloadBoundary>
    <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <ToastProvider>
       <DialogProvider>
        <RootApp />
        <PwaBanners />
       </DialogProvider>
      </ToastProvider>
    </BrowserRouter>
    </QueryClientProvider>
    </ChunkReloadBoundary>
  </React.StrictMode>
);
