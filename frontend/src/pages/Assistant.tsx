
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
