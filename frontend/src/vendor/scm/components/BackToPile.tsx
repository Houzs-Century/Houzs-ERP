// ----------------------------------------------------------------------------
// BackToPile — "Back to Scan bills (N left)" on the pages a pile bill opens
// into (owner 2026-10-06: AP invoice 存好后会有一个按钮「回到扫单（还剩 N 张）」).
// Shows only while this company's pile still holds read bills not yet opened;
// the pile itself lives in bill-pile-store.
// ----------------------------------------------------------------------------

import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { billsLeft, pileKey, usePile, type PileTarget } from '../lib/bill-pile-store';
import { getActiveCompanySnapshot, subscribeActiveCompany } from '../../../lib/activeCompany';

const PILE_PAGE: Record<PileTarget, string> = { ap: '/scm/ap-invoices/scan', pv: '/scm/payment-vouchers/scan' };

export const BackToPile = ({ target }: { target: PileTarget }) => {
  const companyId = useSyncExternalStore(subscribeActiveCompany, getActiveCompanySnapshot, getActiveCompanySnapshot);
  const pile = usePile(pileKey(companyId, target));
  const navigate = useNavigate();
  const left = billsLeft(pile);
  if (left === 0) return null;
  return (
    <button type="button" onClick={() => navigate(PILE_PAGE[target])}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 }}>
      ← Back to Scan bills ({left} left)
    </button>
  );
};
