// ----------------------------------------------------------------------------
// fair-reassign — who may re-assign an order's fair from "Fair Links to Settle"
// (owner 2026-10-16: 「就开放 finance 和 pms 啊」).
//
//   Finance — Accounting access (`scm.finance.accounting`; the `*` wildcard
//             holds it, so the owner and IT admin pass).
//   PMS     — the people who may open a fair: a BD role, the Owner position,
//             weisiang (services/pmsAccess.canCreateEvent, the one rule).
//
// A salesperson still changes the fair on their OWN order through the order's
// edit (「他们还可以更改去对的 project」); this gate is the settle screen, which
// moves anybody's order. Every move is in History (fair-audit.ts).
// ----------------------------------------------------------------------------

import { canCreateEvent } from '../../services/pmsAccess';
import { hasHouzsPerm } from './houzs-perms';
import type { Variables } from '../env';

export const FAIR_REASSIGN_REFUSAL =
  'Only Finance or PMS can re-assign an order’s fair here. Change it on the order itself if it is yours.';

export function canReassignFair(c: { get(key: 'houzsUser'): Variables['houzsUser'] }): boolean {
  return hasHouzsPerm(c, 'scm.finance.accounting') || canCreateEvent(c.get('houzsUser'));
}
