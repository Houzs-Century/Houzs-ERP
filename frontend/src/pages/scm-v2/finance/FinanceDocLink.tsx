// ----------------------------------------------------------------------------
// FinanceDocLink — a document number on a Finance page, in the owner's redesign
// (batch 4 §1; the design's Finance UI conventions): IBM Plex Sans 13/600 with a
// dotted underline, never monospace. A plain click opens the document in its
// own tab of the in-app strip (the rule of lib/openDocInTab), so the list stays
// one click away and the document's Back returns to it (lib/useWorkspaceOpener);
// Ctrl/Cmd/Shift-click opens a browser window, as any link does. One component
// for every Money out page — MerchantRecon's DocLink is a per-page copy.
// ----------------------------------------------------------------------------

import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { markWorkspaceOpenIntent } from '../../../lib/workspaceTabs';
import css from './FinanceDocLink.module.css';

/** The Money out documents a page links to: a payment voucher, an AP bill, a
    purchase invoice. */
export type FinanceDocKind = 'PV' | 'API' | 'PI';

/** Where a Money out document opens — one home: a voucher, a purchase invoice
    and (since batch 4 step 6) an AP bill each on its own page. */
export const financeDocHref = (kind: FinanceDocKind, id: string): string => {
  switch (kind) {
    case 'PV': return `/scm/payment-vouchers/${encodeURIComponent(id)}`;
    case 'PI': return `/scm/purchase-invoices/${encodeURIComponent(id)}`;
    default: return `/scm/ap-invoices/${encodeURIComponent(id)}`;
  }
};

/** `onOpen`: what the page notes before a plain click leaves it (its scroll, its
    ticks), so the document's Back lands on the page as it was. */
export function FinanceDocLink({ to, children, className, onOpen }: { to: string; children: string; className?: string; onOpen?: () => void }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    /* A row that opens on a click must not open as well. */
    e.stopPropagation();
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      onOpen?.();
      markWorkspaceOpenIntent(true);
    }
  };
  return (
    <Link to={to} className={className ? `${css.docLink} ${className}` : css.docLink} title={`Open ${children} in a new tab`}
      onClick={onClick} onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </Link>
  );
}
