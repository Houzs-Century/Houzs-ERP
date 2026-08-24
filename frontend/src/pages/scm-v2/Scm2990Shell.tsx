// Scm2990Shell — the shared app-shell wrapper for every VENDORED 2990's SCM
// page mounted at a parallel /scm/* route. Extracted from the original
// SuppliersV2Route so the PO pages (and future domains) can reuse the exact
// same provider setup instead of each re-declaring it.
//
// The vendored page tree expects three things from its host that 2990's
// provides at its own root but Houzs's main.tsx does not:
//   1. <NotifyProvider>  — supplies useNotify() (create / save / error toasts).
//   2. <ConfirmProvider> — supplies useConfirm() (the in-app "are you sure?"
//      gate the PO detail/list use for Cancel / Reopen / Delete / remove-line).
//      The Suppliers slice never needed this (the list raises no confirm), so
//      the original route stubbed confirm with window.confirm; the PO pages DO
//      call useConfirm(), so it's mounted here for real.
//   3. dialog-service registration — so authedFetch's 409 short-stock confirm
//      and any serviceNotify land in THESE in-app dialogs instead of a naked
//      window.confirm / window.alert. Wired via the bridge below, which now
//      registers the real useConfirm (not the window.confirm fallback).
//
// All providers are scoped to this subtree, so they can't clash with Houzs's
// own toast / dialog providers. QueryClientProvider + BrowserRouter already
// exist in main.tsx and @tanstack/react-query is shared, so the vendored hooks
// just work.

import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { NotifyProvider, useNotify } from '../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider, useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { PromptProvider } from '../../vendor/scm/components/PromptDialog';
import { ChoiceProvider } from '../../vendor/scm/components/ChoiceDialog';
import { PrintChainProvider } from '../../components/scm-v2/PrintChainProvider';
import { registerDialogService } from '../../vendor/scm/lib/dialog-service';
import { rememberScmListReturn } from '../../lib/scmListReturn';
import { prefetchDocCreate } from '../../lib/prefetch-routes';

/** Registers the live confirm + notify fns with the module-level dialog-service
 *  bridge so non-React callers (authedFetch's short-stock gate, query onError
 *  toasts) raise the in-app dialogs. Must render inside BOTH providers. */
function DialogServiceBridge() {
  const notify = useNotify();
  const confirm = useConfirm();
  useEffect(() => {
    registerDialogService({ confirm, notify });
  }, [confirm, notify]);
  return null;
}

/** Records the current SCM LIST url (path + query) so a document detail's Back
 *  button can return to the filtered list the user came from (owner 2026-07-24;
 *  see lib/scmListReturn.ts). No-op on detail/action pages. This shell wraps
 *  every /scm/* list and detail, so it is the one place that sees them all. */
function ScmListReturnTracker() {
  const location = useLocation();
  useEffect(() => {
    rememberScmListReturn(location.pathname, location.search);
    // Warm this list's "New" form chunk while the operator reads the list, so the
    // New button doesn't cold-load its lazy chunk and flash the skeleton. No-op on
    // detail/create pages (no `<path>/new` chunk exists for them).
    prefetchDocCreate(location.pathname);
  }, [location.pathname, location.search]);
  return null;
}

export function Scm2990Shell({ children }: { children: ReactNode }) {
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ChoiceProvider>
            {/* Print preview for ANY document, opened imperatively from a row
                menu — inside ChoiceProvider so it sits in the same dialog band
                as Confirm / Choice / Notify and can use them. */}
            <PrintChainProvider>
            <DialogServiceBridge />
            <ScmListReturnTracker />
            {/* Nick 2026-07-09 — "local host 还没有上面 pin 起来". `overflow-x:
                hidden` on this wrapper creates a scroll container that traps
                position: sticky on every descendant edit-mode header (the SO
                Detail sticky worked on the V2 read-only page but broke on
                the forwarded editor because Suspense delays the render past
                the point the sticky context was established). `overflow-x:
                clip` clips the same overflow WITHOUT establishing a scroll
                container, so descendant sticky elements work again. Modern
                browsers (Chrome 90+, Firefox 81+, Safari 16+) all support
                it — Nick's on current Chrome. */}
            <div className="scm2990 max-w-full [overflow-x:clip]">{children}</div>
            </PrintChainProvider>
          </ChoiceProvider>
        </PromptProvider>
      </ConfirmProvider>
    </NotifyProvider>
  );
}

export default Scm2990Shell;
