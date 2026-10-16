/* Shared pieces of the list quick-view drawer — the right slide-over a row
   click opens on the Sales Order / Delivery Order lists. The consignment
   lists (CR, PCO, PCR, PCT) compose their drawers from these so the six
   consignment surfaces read as one family. Data stays in each page; this
   file is layout only. */
import type { ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { cn } from '../../lib/utils';

export type DrawerTone = 'success' | 'warning' | 'error' | 'neutral';

/* Dark header + scroll body + footer, inside the shared resizable panel. */
export function QuickViewShell({
  open,
  onClose,
  ariaLabel,
  docNo,
  docLabel,
  statusLabel,
  statusTone,
  onOpenFull,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  docNo: string;
  docLabel: string;
  statusLabel: string;
  statusTone: DrawerTone;
  onOpenFull: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <ResizableDetailDrawer open={open} onClose={onClose} ariaLabel={ariaLabel}>
      {open && (
        <>
          <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
            <button
              type="button"
              onClick={onClose}
              className="text-sidebar-ink-muted hover:text-sidebar-ink"
              aria-label="Close details"
            >
              <X size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[14px] font-bold tracking-wide">{docNo}</div>
              <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">{docLabel}</div>
            </div>
            <button
              type="button"
              onClick={onOpenFull}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
            >
              Open full page <ExternalLink size={12} />
            </button>
            <Badge tone={statusTone} variant="solid" size="xs">{statusLabel}</Badge>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
            {footer}
          </div>
        </>
      )}
    </ResizableDetailDrawer>
  );
}

export function DrawerMeta({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className={cn('mt-0.5 text-[13px] font-semibold text-ink', mono && 'font-mono')}>{v}</dd>
    </div>
  );
}

export function DrawerMetaGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
      {children}
    </dl>
  );
}

export function DrawerSection({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{children}</div>
  );
}

export function DrawerKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">{v}</span>
    </div>
  );
}

/* Customer / supplier card: initials avatar, name, code, then DrawerKV rows. */
export function DrawerPartyCard({ name, code, children }: { name: string; code?: string | null; children: ReactNode }) {
  const initials = (name || 'C').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || 'C';
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
          {initials}
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-ink">{name || '—'}</div>
          {code && <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">{code}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

export function DrawerTotals({ children }: { children: ReactNode }) {
  return <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">{children}</div>;
}

export function DrawerTotal({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'success' | 'error' }) {
  return (
    <div className={cn('flex items-center justify-between py-1.5', strong && 'border-t border-border-subtle pt-2.5 mt-1')}>
      <span className={cn('text-[12px] text-ink-muted', strong && 'text-[13px] font-semibold text-ink')}>{k}</span>
      <span className={cn(
        'font-money text-[13px] font-semibold',
        strong && 'text-[15px] font-bold text-ink',
        tone === 'success' && 'text-synced',
        tone === 'error' && 'text-err',
      )}>{v}</span>
    </div>
  );
}

/* Line list: header row + body. `cols` is the Tailwind grid-cols template
   shared by header and rows; `state` renders the loading / error / empty
   placeholder instead of rows. */
export function DrawerLines({
  cols,
  headings,
  loading,
  error,
  empty,
  children,
}: {
  cols: string;
  headings: Array<{ label: string; right?: boolean }>;
  loading: boolean;
  error: string | null;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className={cn('grid gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted', cols)}>
        {headings.map((h) => <span key={h.label} className={h.right ? 'text-right' : undefined}>{h.label}</span>)}
      </div>
      {loading && <div className="px-4 py-8 text-center text-[12px] text-ink-muted">Loading lines…</div>}
      {!loading && error && <div className="px-4 py-8 text-center text-[12px] text-err">{error}</div>}
      {!loading && !error && empty && <div className="px-4 py-8 text-center text-[12px] text-ink-muted">No lines</div>}
      {!loading && !error && children}
    </div>
  );
}

export function DrawerLineRow({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div className={cn('grid items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0', cols)}>
      {children}
    </div>
  );
}

export function DrawerLineItem({ pill, primary, secondary }: { pill?: ReactNode; primary: string; secondary?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {pill}
        <span className="text-[12.5px] font-medium leading-snug text-ink">{primary || '—'}</span>
      </div>
      {secondary && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{secondary}</div>}
    </div>
  );
}

export const drawerErrorText = (q: { isError: boolean; error: unknown }): string | null =>
  q.isError ? (q.error instanceof Error ? q.error.message : 'Failed to load lines') : null;
