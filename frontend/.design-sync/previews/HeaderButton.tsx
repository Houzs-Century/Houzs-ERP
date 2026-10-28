import { HeaderButton } from "autocount-sync-frontend";
import { Printer, Check, Trash2, Send } from "lucide-react";

// Compact uppercase action button for detail-page headers.

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <HeaderButton variant="ghost">
      <Printer size={13} /> Print DO
    </HeaderButton>
    <HeaderButton variant="primary">
      <Check size={13} /> Approve
    </HeaderButton>
    <HeaderButton variant="danger">
      <Trash2 size={13} /> Void
    </HeaderButton>
  </div>
);

export const Disabled = () => (
  <div className="flex items-center gap-2">
    <HeaderButton variant="primary" disabled>
      <Send size={13} /> Push to AutoCount
    </HeaderButton>
    <HeaderButton variant="ghost" disabled>
      <Printer size={13} /> Print
    </HeaderButton>
  </div>
);

export const HeaderRow = () => (
  <div className="flex w-[26rem] items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Sales Order</div>
      <div className="text-[15px] font-semibold text-ink">SO-2990-0417</div>
    </div>
    <div className="flex gap-2">
      <HeaderButton variant="ghost">
        <Printer size={13} /> Print
      </HeaderButton>
      <HeaderButton variant="primary">
        <Check size={13} /> Confirm
      </HeaderButton>
    </div>
  </div>
);
