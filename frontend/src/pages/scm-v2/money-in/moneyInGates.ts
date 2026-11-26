
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';

export type MoneyInGates = {
  paperKeys: boolean;
  createKeys: boolean;
};

export function useMoneyInGates(): MoneyInGates {
  const { user, can, pageAccess } = useHouzsAuth();
  const shared = (!user?.scm_l2_configured && can('scm.access')) || pageAccess('scm.finance.money_in') !== 'none';
  return {
    paperKeys: shared || can('scm.payment_voucher.post') || can('scm.sales_order.write'),
    createKeys: shared || can('scm.payment_voucher.create'),
  };
}
