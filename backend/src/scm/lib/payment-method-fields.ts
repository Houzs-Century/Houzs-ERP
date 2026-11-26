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
