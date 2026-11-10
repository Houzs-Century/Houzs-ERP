// PN-YYMM-NNN, unique per company. The number comes from the shared atomic
// counter floored at the month's live max: two penalties saved at the same
// moment used to read the same max, and the second hit the unique constraint
// and failed with a server error. The series carries the company because the
// counter table is global while two companies may both hold PN-2611-001.
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
