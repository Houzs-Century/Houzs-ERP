
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
