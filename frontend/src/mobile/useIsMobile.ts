import { useEffect, useState } from "react";

/** True on phone / tablet-portrait — on TOUCH DEVICES only. A desktop/laptop
 *  (fine primary pointer, non-mobile UA) stays on the PC version at ANY window
 *  size (owner 2026-07-31: shrinking/snapping the window must not flip the UI
 *  to mobile). Phones/tablets keep the width behaviour: portrait = mobile,
 *  wide landscape = desktop — unchanged.
 *  Override on a desktop browser to preview the mobile app: add `?mobile=1` to
 *  the URL (or `?mobile=0` to force desktop). The choice sticks for the session. */
export function useIsMobile(breakpoint = 1024): boolean {
  const forced = readForcedOverride();
  const touchDevice = typeof window !== "undefined" && isTouchDevice();
  const [mobile, setMobile] = useState(
    () => forced ?? (touchDevice && typeof window !== "undefined" && window.innerWidth < breakpoint),
  );
  useEffect(() => {
    if (forced != null) {
      setMobile(forced);
      return;
    }
    if (!touchDevice) {
      // PC: pinned to desktop — no resize listener, no flipping.
      setMobile(false);
      return;
    }
    const onResize = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint, forced, touchDevice]);
  return mobile;
}

/** Phone/tablet detection: primary pointer is coarse (touch), or a mobile UA.
 *  A touchscreen Windows laptop keeps a FINE primary pointer (trackpad/mouse),
 *  so it counts as PC; an iPad in desktop-mode Safari masquerades as a Mac in
 *  the UA but its coarse pointer still marks it as a touch device. */
function isTouchDevice(): boolean {
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
  } catch {
    return false;
  }
}

function readForcedOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("mobile");
    // sessionStorage, NOT localStorage -- the preview override must die with
    // the tab. The old localStorage flag stuck FOREVER: a one-time ?mobile=1
    // preview left the owner's desktop permanently on the phone UI. Also
    // clear any legacy sticky flag.
    localStorage.removeItem("hz_force_mobile");
    if (q === "1") sessionStorage.setItem("hz_force_mobile", "1");
    else if (q === "0") sessionStorage.removeItem("hz_force_mobile");
    if (sessionStorage.getItem("hz_force_mobile") === "1") return true;
    if (q === "0") return false;
    return null;
  } catch {
    return null;
  }
}
