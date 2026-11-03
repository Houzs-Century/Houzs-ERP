// ----------------------------------------------------------------------------
// AccountingHeader — the head of an Accounting page tab in the owner's
// redesign (batch 6 §1.2): no tab strip, the sub-page's name as the title and
// "Finance · <section>" above it, the section the sidebar files the tab under.
// Journal entries, General ledger and Trial balance are reached from Books and
// from the report list; opened from the list (`in=reports`) they read
// "Finance · Reports". A tab with header actions renders this itself; the
// Accounting page renders it bare for the rest.
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../../components/Layout';
import { ACCOUNTING_TAB_TITLES, type AccountingTab } from '../accounting-tabs';

export type AccountingSection = 'Books' | 'Reports' | 'Setup';

/** The sidebar section an Accounting tab sits under — its header's eyebrow. */
export function accountingSection(tab: AccountingTab, inReports: boolean): AccountingSection {
  switch (tab) {
    case 'je':
    case 'gl':
    case 'tb':
      return inReports ? 'Reports' : 'Books';
    case 'check':
    case 'close':
      return 'Books';
    case 'coa':
    case 'groups':
      return 'Setup';
    default:
      return 'Reports';
  }
}

export function AccountingHeader({ tab, description, actions }: { tab: AccountingTab; description?: string; actions?: ReactNode }) {
  const [params] = useSearchParams();
  const section = accountingSection(tab, params.get('in') === 'reports');
  return <PageHeader eyebrow={`Finance · ${section}`} title={ACCOUNTING_TAB_TITLES[tab]} description={description} actions={actions} />;
}
