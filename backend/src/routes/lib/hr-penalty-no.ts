export async function mintPenaltyNo(
  existing: string[],
  companyId: number,
  date: string,
  claim: (series: string, floor: number) => Promise<number | null>,
): Promise<string> {
  const prefix = `PN-${date.slice(2, 4)}${date.slice(5, 7)}-`;
  const floor = existing.reduce((m, no) => (no.startsWith(prefix) ? Math.max(m, Number(no.slice(prefix.length)) || 0) : m), 0);
  const next = (await claim(`HR-C${companyId}-${prefix.slice(0, -1)}`, floor)) ?? floor + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}
