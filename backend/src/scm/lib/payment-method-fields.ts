/* FIX 3 (2026-07-16) — method => bank/account mapping, enforced server-side.
   The desktop New-SO / Payments cascade blocks saving a Merchant payment with
   no Bank or an Online (transfer) payment with no Sub-Type
   (missingMethodSubField in PaymentsTable.tsx), but mobile / API POST straight
   to the payments route and its schema left every sub-field optional. Mirror
   the desktop rule for the SERVER-observable part: an amount-bearing Merchant
   needs a Bank (merchantProvider); an Online/transfer needs a Sub-Type
   (onlineType); Cash and legacy Installment need nothing. NOTE: the desktop also
   makes a Merchant pick a Plan, but "One-off" serialises to installmentMonths
   null — indistinguishable from unset — so requiring it here would reject a
   legitimate one-shot card payment; the Plan is deliberately NOT gated. Only
   amount > 0 rows are checked, matching the desktop guard (a zeroed row carries
   no method commitment).

   Shared by POST /:docNo/payments and the backdate request, so a request cannot
   park a payment the approval would then have to refuse. */
export function paymentMethodFieldRefusal(p: {
  method: string;
  amountSen: number;
  merchantProvider?: string | null;
  onlineType?: string | null;
}): { error: 'payment_method_field_required'; reason: string } | null {
  if (p.amountSen <= 0) return null;
  let missing: string | null = null;
  let methodName = '';
  if (p.method === 'merchant' && !p.merchantProvider?.trim()) { missing = 'bank'; methodName = 'card / merchant'; }
  else if (p.method === 'transfer' && !p.onlineType?.trim()) { missing = 'sub-type'; methodName = 'bank transfer / online'; }
  if (!missing) return null;
  return {
    error: 'payment_method_field_required',
    reason: `A ${methodName} payment needs a ${missing} before it can be recorded.`,
  };
}
