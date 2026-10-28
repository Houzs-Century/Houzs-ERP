import { Badge, ResizableDetailDrawer } from "autocount-sync-frontend";

// The SCM detail drawer's resizable sibling — bare fixed right-side shell
// (no built-in header): the caller renders its own content; width drags on
// the left edge and persists under the shared DETAIL_DRAWER_WIDTH_KEY.
// Fixed-position overlay → cardMode single with its own viewport.

try {
  localStorage.removeItem("panel-scm-detail-drawer.v1");
} catch {
  /* private mode */
}

const Row = ({ k, v, money }: { k: string; v: string; money?: boolean }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2 last:border-0">
    <span className="text-[11px] text-ink-muted">{k}</span>
    <span className={money ? "font-money text-[13px] text-ink" : "text-[13px] text-ink"}>{v}</span>
  </div>
);

export const Open = () => (
  <ResizableDetailDrawer open onClose={() => {}} ariaLabel="Sales order detail">
    {/* Explicit height — the drawer's h-full can't resolve inside the
        card-capture wrapper, so the content pins the visible height. */}
    <div className="flex h-[560px] flex-col">
      <div className="border-b border-border bg-surface-2 px-5 py-4">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
          Sales Order
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-mono text-[15px] font-bold text-ink">SO-2990-0417</span>
          <Badge tone="success">Confirmed</Badge>
        </div>
        <div className="text-[12px] text-ink-secondary">Aurora Marble Dining Set · Sunway Geo Residences</div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <Row k="Customer" v="Sunway Geo Residences — Tower B" />
        <Row k="Salesperson" v="Farra Aziz" />
        <Row k="Order date" v="2026-07-18" />
        <Row k="Delivery" v="2026-08-02 · KL/SEL" />
        <Row k="Lines" v="12" />
        <Row k="Subtotal" v="RM 19,340.00" money />
        <Row k="Balance" v="RM 4,890.00" money />
      </div>
    </div>
  </ResizableDetailDrawer>
);
