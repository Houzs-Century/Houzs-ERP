import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { UNSAFE_NavigationContext, parsePath, useLocation, type Navigator } from "react-router-dom";
import { useDialog } from "../hooks/useDialog";
import {
  confirmLeaving,
  historyIndex,
  leaveGuardActive,
  leavesPlace,
  setLeaveGuardAsker,
  shouldBlockUnload,
} from "../lib/leaveGuard";

/**
 * Mounted once, inside the router and the dialog provider. Asks before any way
 * out of a page while a form holds the guard (lib/leaveGuard explains why the
 * navigator is wrapped rather than using `useBlocker`).
 */
export function LeaveGuardBridge() {
  const dialog = useDialog();
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const location = useLocation();
  const here = useRef({ pathname: location.pathname, search: location.search, index: historyIndex() });
  // Layout effect: current before any page's own effect can navigate again.
  useLayoutEffect(() => {
    here.current = { pathname: location.pathname, search: location.search, index: historyIndex() };
  }, [location]);

  useEffect(() => {
    setLeaveGuardAsker(() =>
      dialog.confirm({
        title: "Leave without saving?",
        message: "What you typed on this page has not been saved. If you leave now it is lost.",
        confirmLabel: "Leave and discard",
        cancelLabel: "Stay on this page",
        danger: true,
      }),
    );
    return () => setLeaveGuardAsker(null);
  }, [dialog]);

  useEffect(() => {
    const nav = navigator as Navigator;
    const { push, replace } = nav;
    const guarded =
      (go: Navigator["push"]): Navigator["push"] =>
      (...args) => {
        const [to] = args;
        const target = typeof to === "string" ? parsePath(to) : to;
        if (!leaveGuardActive() || !leavesPlace(here.current, target)) {
          go(...args);
          return;
        }
        void confirmLeaving().then((leave) => {
          if (leave) go(...args);
        });
      };
    nav.push = guarded(push);
    nav.replace = guarded(replace);

    // Back / Forward (a phone's back gesture too): the browser has already moved
    // by the time this fires. Capture runs before the router's own listener, so
    // hide the move from it, step back to where we were, then ask.
    const onPop = (e: PopStateEvent) => {
      if (!leaveGuardActive()) return;
      const from = here.current.index;
      const to = historyIndex();
      if (from === null || to === null || to === from) return;
      if (!leavesPlace(here.current, window.location)) return;
      e.stopImmediatePropagation();
      const delta = to - from;
      window.history.go(-delta);
      void confirmLeaving().then((leave) => {
        if (leave) window.history.go(delta);
      });
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!shouldBlockUnload()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("popstate", onPop, { capture: true });
    window.addEventListener("beforeunload", onUnload);
    return () => {
      nav.push = push;
      nav.replace = replace;
      window.removeEventListener("popstate", onPop, { capture: true });
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [navigator]);

  return null;
}
