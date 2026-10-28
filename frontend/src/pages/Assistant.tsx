// ---------------------------------------------------------------------------
// Assistant — the unified ERP chat, full-page route (spec §2). The chat itself
// is the shared <AssistantChat/> (also used by the floating AssistantPanel and,
// next, the mobile surface), so there is ONE chat implementation, not several.
// This page is just the framed, full-height host reachable at /assistant — for
// deep links and the panel's "open full page" action.
// ---------------------------------------------------------------------------

import { PageHeader } from "../components/Layout";
import { AssistantChat } from "../components/AssistantChat";

export function Assistant() {
  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Assistant"
        description="Ask about orders, deliveries, payments, stock or sales. It reads the agents' findings — it never changes anything."
      />

      <div className="flex h-[62vh] flex-col overflow-hidden rounded-md border border-border bg-surface shadow-stone">
        <AssistantChat className="flex-1" />
      </div>
    </div>
  );
}
