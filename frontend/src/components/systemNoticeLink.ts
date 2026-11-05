// ----------------------------------------------------------------------------
// systemNoticeLink — where a system notice in the bell opens, read from its
// `source` tag. Most machine notices carry no place (a scan result, a service
// case: the words are the whole message). A payment voucher reminder carries
// its voucher (backend scm/routes/payment-vouchers-remind.ts, PV_REMIND_SOURCE):
//
//   pv_approval:<company id>:<voucher id>  → that voucher
//   pv_approval:<company id>               → the checked vouchers (one note for several)
//
// The company rides along because the bell lists every company's notices while
// a page reads the tab's own company: a note about another company's voucher
// opens in a new window on that company — the switcher's own ?company= hand-off
// (lib/activeCompany.ts consumeCompanyUrlSeed) — never in this tab under the
// wrong one.
// ----------------------------------------------------------------------------

export type SystemNoticeLink = { to: string; companyId: number | null };

export function systemNoticeLink(source: string | null | undefined): SystemNoticeLink | null {
  const [tag, company = '', id = ''] = String(source ?? '').split(':');
  if (tag !== 'pv_approval') return null;
  if (id && !/^[\w-]{1,64}$/.test(id)) return null;
  return {
    to: id ? `/scm/payment-vouchers/${id}` : '/scm/payment-vouchers?status=CHECKED',
    companyId: /^\d{1,9}$/.test(company) ? Number(company) : null,
  };
}

/** True when the link belongs to a company other than the one this tab works in. */
export const opensElsewhere = (link: SystemNoticeLink, activeCompanyId: number | null): boolean =>
  link.companyId != null && activeCompanyId != null && link.companyId !== activeCompanyId;

/** The address that opens it in a new window on its own company. */
export const inItsCompany = (link: SystemNoticeLink): string =>
  `${link.to}${link.to.includes('?') ? '&' : '?'}company=${link.companyId ?? ''}`;
