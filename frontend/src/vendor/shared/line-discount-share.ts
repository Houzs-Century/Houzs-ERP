export function lineDiscountShare(
  lineDiscountSen: number,
  lineQty: number,
  alreadyMovedQty: number,
  movingQty: number,
): number {
  const discount = Math.max(0, Math.trunc(Number(lineDiscountSen) || 0));
  const qty = Number(lineQty) || 0;
  if (discount === 0 || qty <= 0) return 0;
  const before = Math.min(qty, Math.max(0, Number(alreadyMovedQty) || 0));
  const after = Math.min(qty, before + Math.max(0, Number(movingQty) || 0));
  const upTo = (q: number) => (q >= qty ? discount : Math.round((discount * q) / qty));
  return upTo(after) - upTo(before);
}
