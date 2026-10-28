import { useEffect, useState, lazy, type ReactNode } from "react";
import { LazySlot } from "../components/LazySlot";
import { useAuth } from "./AuthContext";
import {
  HOUZS_COMPANY_CODE,
  defaultBrandingForCompany,
  hostDefaultCompanyCode,
  shortCompanyName,
} from "../lib/branding";
import { useIsMobile } from "../mobile/useIsMobile";

// Code-split the mobile app: desktop users never download it, and it stays out
// of the initial JS bundle (keeps the bundle-budget CI gate green).
const MobileApp = lazy(() =>
  import("../mobile/MobileApp").then((m) => ({ default: m.MobileApp })),
);
const MobileLogin = lazy(() =>
  import("../mobile/MobileLogin").then((m) => ({ default: m.MobileLogin })),
);

// The unauthenticated screens are code-split too (2026-07-23, bundle diet):
// a signed-in session boots straight past the gate, so it should never
// download the login/bootstrap/invite UI — AuthShell, the password-strength
// meter, AmbientSnow, loginErrors — ~19 KB raw that used to ride in the
// initial chunk. The splash below doubles as the Suspense fallback, so the
// pre-login sequence stays one steady frame instead of flashing.
const LoginScreen = lazy(() =>
  import("./AuthScreens").then((m) => ({ default: m.LoginScreen })),
);
const ForgotPasswordScreen = lazy(() =>
  import("./AuthScreens").then((m) => ({ default: m.ForgotPasswordScreen })),
);
const BootstrapScreen = lazy(() =>
  import("./AuthScreens").then((m) => ({ default: m.BootstrapScreen })),
);
const AcceptInviteScreen = lazy(() =>
  import("./AuthScreens").then((m) => ({ default: m.AcceptInviteScreen })),
);

/** Neutral splash — the session-resolving frame, reused as the Suspense
 *  fallback while an unauthenticated screen's chunk downloads. */
function AuthSplash() {
  return (
    <div className="paper-grain flex min-h-screen items-center justify-center">
      <div className="font-display text-[12px] uppercase tracking-brand text-ink-muted">
        {hostDefaultCompanyCode() === HOUZS_COMPANY_CODE
          ? "Houzs Century"
          : shortCompanyName(
              defaultBrandingForCompany(hostDefaultCompanyCode()).companyName,
            )}{" "}
        · Loading
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Gate — picks the right screen based on auth state
// ──────────────────────────────────────────────────────────
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, hasUsers } = useAuth();
  const isMobile = useIsMobile();
  // The mobile build exists ONLY for HOUZS (the owner's phone design). 2990 (and
  // any other company) has no mobile UI, so on the 2990 host we fall back to the
  // desktop app even on phones — "2990 手机关闭".
  const mobileEnabled = isMobile && hostDefaultCompanyCode() === HOUZS_COMPANY_CODE;

  // Track the hash so in-page links (#forgot, back-to-login) re-render
  // the gate without a full navigation. #invite= arrives as a fresh
  // page load, but gets the same reactivity for free.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Every slot below is a LazySlot, never a bare <Suspense>. This file is where
  // the whole mobile product is chosen (`<MobileApp />`), and until 2026-08-18
  // it mounted from a bare <Suspense> with no boundary between it and
  // main.tsx's UNKEYED top-level ChunkReloadBoundary. A phone holding a cached
  // index.html that signs in after a deploy fetches a hashed MobileApp-*.js
  // that no longer exists; once the automatic ladder is spent, that top-level
  // panel replaced the ENTIRE tree — including the <NewVersionBanner /> mounted
  // beside AuthGate in main.tsx, i.e. the one thing on screen that explains
  // what happened. The five auth screens have the same shape and are reached
  // exactly when a session expires onto a chunk this tab never fetched.
  //
  // Scoped here, the crash panel replaces only the gate's own subtree: the
  // banner survives next to it, and any move between gate screens (#forgot →
  // login, invite → login, signing in) changes `resetKey` and clears it without
  // a reload. The mobile SHELL key is deliberately near-constant — there is no
  // navigation above it to clear a crash with — so for that slot the win is the
  // banner surviving and the panel's own Reload being the honest exit.
  const slotKey = (screen: string) => `authgate:${screen}:${hash}`;

  // Initial loading state — neutral splash
  if (loading) {
    return <AuthSplash />;
  }

  // No users in the database → first-owner bootstrap
  if (hasUsers === false) {
    return (
      <LazySlot resetKey={slotKey("bootstrap")} fallback={<AuthSplash />}>
        <BootstrapScreen />
      </LazySlot>
    );
  }

  // Not signed in → login (or invite acceptance / forgot password via
  // URL hash)
  if (!user) {
    if (hash.startsWith("#invite=")) {
      return (
        <LazySlot resetKey={slotKey("invite")} fallback={<AuthSplash />}>
          <AcceptInviteScreen />
        </LazySlot>
      );
    }
    if (hash === "#forgot") {
      return (
        <LazySlot resetKey={slotKey("forgot")} fallback={<AuthSplash />}>
          <ForgotPasswordScreen />
        </LazySlot>
      );
    }
    return mobileEnabled ? (
      <LazySlot resetKey={slotKey("login-mobile")} fallback={null}>
        <MobileLogin />
      </LazySlot>
    ) : (
      <LazySlot resetKey={slotKey("login")} fallback={<AuthSplash />}>
        <LoginScreen />
      </LazySlot>
    );
  }

  return mobileEnabled ? (
    <LazySlot resetKey={slotKey("shell-mobile")} fallback={null}>
      <MobileApp />
    </LazySlot>
  ) : (
    <>{children}</>
  );
}
