
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { NotifyProvider, useNotify } from '../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider, useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { PromptProvider } from '../../vendor/scm/components/PromptDialog';
import { ChoiceProvider } from '../../vendor/scm/components/ChoiceDialog';
import { VpBrandPromptBridge } from '../../vendor/scm/components/VpBrandPromptBridge';
import { PrintChainProvider } from '../../components/scm-v2/PrintChainProvider';
import { registerDialogService } from '../../vendor/scm/lib/dialog-service';
import { rememberScmListReturn } from '../../lib/scmListReturn';
import { prefetchDocCreate } from '../../lib/prefetch-routes';

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
            <PrintChainProvider>
            <DialogServiceBridge />
            <VpBrandPromptBridge />
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
