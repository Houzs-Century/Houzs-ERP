/* Who reaches the payment backdate inbox and its sidebar entry: the backdate
   right (Finance, `*`) or the approve-only key (Logistic) — the server's own
   rule. Its own import-free module because App and Sidebar are in the initial
   bundle and must not pull the request client in with it. */
export const PAYMENT_BACKDATE_KEY = 'scm.payment.backdate';
export const BACKDATE_DECIDER_PERMS: string[] = ['*', PAYMENT_BACKDATE_KEY, 'scm.payment.backdate.approve'];
