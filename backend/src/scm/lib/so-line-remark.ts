export function soLineRemark(item: { remark?: unknown; variants?: unknown }): string | null {
  const own = typeof item.remark === 'string' ? item.remark.trim() : '';
  if (own !== '') return own;
  const v = (item.variants as { remark?: unknown } | null | undefined)?.remark;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
