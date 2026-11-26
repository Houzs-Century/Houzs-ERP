import { useEffect, useState, lazy, type ReactNode } from "react";
import { LazySlot } from "../components/LazySlot";
import { headStartFailed, lazyPage } from "../lib/lazyPage";
import { useAuth } from "./AuthContext";
import {
  HOUZS_COMPANY_CODE,
  defaultBrandingForCompany,
  hostDefaultCompanyCode,
  shortCompanyName,
} from "../lib/branding";
import { useIsMobile } from "../mobile/useIsMobile";
import { useLocation } from "react-router-dom";

const MobileApp = lazyPage(() =>
  import("../mobile/MobileApp").then((m) => ({ default: m.MobileApp })),
);

/** Whether a phone gets the mobile shell: the mobile build exists for the base
 *  company only (owner: 2990 手机关闭). One home, shared with main.tsx's boot
 *  preload so the two can never pick different shells. */
export function mobileShellEnabled(isMobile: boolean): boolean {
  const mobileEnabled = isMobile && hostDefaultCompanyCode() === HOUZS_COMPANY_CODE;
  return mobileEnabled;
}

/** Start the phone shell's chunk at boot, in parallel with /api/auth/me, rather
 *  than after it (main.tsx, signed-in phone sessions only). */
export function preloadMobileApp(): void {
  void MobileApp.preload().catch(headStartFailed);
}
const AiConnect = lazyPage(() => import("../pages/AiConnect").then((m) => ({ default: m.AiConnect })));
const AiConnector = lazyPage(() => import("../pages/AiConnector").then((m) => ({ default: m.AiConnector })));

const MobileLogin = lazy(() =>
  import("../mobile/MobileLogin").then((m) => ({ default: m.MobileLogin })),
);

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
const ForcedPasswordChangeScreen = lazy(() =>
  import("./AuthScreens").then((m) => ({ default: m.ForcedPasswordChangeScreen })),
);

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

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading, hasUsers } = useAuth();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  // The mobile build exists ONLY for HOUZS (the owner's phone design). 2990 (and
  // any other company) has no mobile UI, so on the 2990 host we fall back to the
  // desktop app even on phones — "2990 手机关闭".
  const mobileEnabled = mobileShellEnabled(isMobile);

  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const slotKey = (screen: string) => `authgate:${screen}:${hash}`;

  if (loading) {
    return <AuthSplash />;
  }

  if (hasUsers === false) {
    return (
      <LazySlot resetKey={slotKey("bootstrap")} fallback={<AuthSplash />}>
        <BootstrapScreen />
      </LazySlot>
    );
  }

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

  if (user.password_change_required) {
    return (
      <LazySlot resetKey={slotKey("password-change")} fallback={<AuthSplash />}>
        <ForcedPasswordChangeScreen />
      </LazySlot>
    );
  }

  if (pathname === "/ai-connect") {
    return (
      <LazySlot resetKey={slotKey("ai-connect")} fallback={<AuthSplash />}>
        <AiConnect />
      </LazySlot>
    );
  }
  if (mobileEnabled && pathname === "/ai-connector") {
    return (
      <LazySlot resetKey={slotKey("ai-connector-mobile")} fallback={<AuthSplash />}>
        <div className="min-h-screen bg-surface-dim">
          <AiConnector />
        </div>
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
