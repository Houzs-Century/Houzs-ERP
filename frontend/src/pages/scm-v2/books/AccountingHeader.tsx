
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
    case 'commrel':
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
