// Malaysian federal public holidays. Seed covers 2024–2027. Where a
// holiday is movable (Chinese New Year, Hari Raya, Wesak Day, etc.)
// the date reflects the official gazetted date; weekend-carryover
// replacement days (common in Malaysia when a holiday falls on a
// Sunday) are included as separate entries.
//
// Not state-specific — state-only holidays (Selangor Sultan's Birthday,
// Hari Hol Perak, FT Day, etc.) are intentionally omitted to keep the
// calendar chrome consistent for the whole ops team.

export interface Holiday {
  /** ISO yyyy-mm-dd */
  date: string;
  name: string;
  /** "federal" | "observed" (replacement day for a weekend holiday). */
  kind?: "federal" | "observed";
}

const MY_FEDERAL_HOLIDAYS: Holiday[] = [
  // ── 2024 ─────────────────────────────────────────────
  { date: "2024-01-01", name: "New Year's Day" },
  { date: "2024-02-10", name: "Chinese New Year" },
  { date: "2024-02-11", name: "Chinese New Year (Day 2)" },
  { date: "2024-02-12", name: "Chinese New Year (Observed)", kind: "observed" },
  { date: "2024-04-10", name: "Hari Raya Aidilfitri" },
  { date: "2024-04-11", name: "Hari Raya Aidilfitri (Day 2)" },
  { date: "2024-05-01", name: "Labour Day" },
  { date: "2024-05-22", name: "Wesak Day" },
  { date: "2024-06-03", name: "Agong's Birthday" },
  { date: "2024-06-17", name: "Hari Raya Aidiladha" },
  { date: "2024-07-07", name: "Awal Muharram" },
  { date: "2024-08-31", name: "National Day (Merdeka)" },
  { date: "2024-09-16", name: "Malaysia Day" },
  { date: "2024-09-16", name: "Prophet Muhammad's Birthday" },
  { date: "2024-10-31", name: "Deepavali" },
  { date: "2024-12-25", name: "Christmas Day" },

  // ── 2025 ─────────────────────────────────────────────
  { date: "2025-01-01", name: "New Year's Day" },
  { date: "2025-01-29", name: "Chinese New Year" },
  { date: "2025-01-30", name: "Chinese New Year (Day 2)" },
  { date: "2025-03-31", name: "Hari Raya Aidilfitri" },
  { date: "2025-04-01", name: "Hari Raya Aidilfitri (Day 2)" },
  { date: "2025-05-01", name: "Labour Day" },
  { date: "2025-05-12", name: "Wesak Day" },
  { date: "2025-06-02", name: "Agong's Birthday" },
  { date: "2025-06-07", name: "Hari Raya Aidiladha" },
  { date: "2025-06-27", name: "Awal Muharram" },
  { date: "2025-08-31", name: "National Day (Merdeka)" },
  { date: "2025-09-05", name: "Prophet Muhammad's Birthday" },
  { date: "2025-09-16", name: "Malaysia Day" },
  { date: "2025-10-20", name: "Deepavali" },
  { date: "2025-12-25", name: "Christmas Day" },

  // ── 2026 ─────────────────────────────────────────────
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-02-17", name: "Chinese New Year" },
  { date: "2026-02-18", name: "Chinese New Year (Day 2)" },
  { date: "2026-03-20", name: "Hari Raya Aidilfitri" },
  { date: "2026-03-21", name: "Hari Raya Aidilfitri (Day 2)" },
  { date: "2026-05-01", name: "Labour Day" },
  { date: "2026-05-28", name: "Hari Raya Aidiladha" },
  { date: "2026-05-31", name: "Wesak Day" },
  { date: "2026-06-01", name: "Agong's Birthday" },
  { date: "2026-06-17", name: "Awal Muharram" },
  { date: "2026-08-26", name: "Prophet Muhammad's Birthday" },
  { date: "2026-08-31", name: "National Day (Merdeka)" },
  { date: "2026-09-16", name: "Malaysia Day" },
  { date: "2026-11-08", name: "Deepavali" },
  { date: "2026-12-25", name: "Christmas Day" },

  // ── 2027 ─────────────────────────────────────────────
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-02-06", name: "Chinese New Year" },
  { date: "2027-02-07", name: "Chinese New Year (Day 2)" },
  { date: "2027-03-10", name: "Hari Raya Aidilfitri" },
  { date: "2027-03-11", name: "Hari Raya Aidilfitri (Day 2)" },
  { date: "2027-05-01", name: "Labour Day" },
  { date: "2027-05-17", name: "Hari Raya Aidiladha" },
  { date: "2027-05-20", name: "Wesak Day" },
  { date: "2027-06-05", name: "Agong's Birthday" },
  { date: "2027-06-06", name: "Awal Muharram" },
  { date: "2027-08-15", name: "Prophet Muhammad's Birthday" },
  { date: "2027-08-31", name: "National Day (Merdeka)" },
  { date: "2027-09-16", name: "Malaysia Day" },
  { date: "2027-10-28", name: "Deepavali" },
  { date: "2027-12-25", name: "Christmas Day" },
];

const BY_DATE = new Map<string, Holiday[]>();
for (const h of MY_FEDERAL_HOLIDAYS) {
  const arr = BY_DATE.get(h.date) ?? [];
  arr.push(h);
  BY_DATE.set(h.date, arr);
}

export function getHolidaysOn(iso: string): Holiday[] {
  return BY_DATE.get(iso) ?? [];
}

export function isHoliday(iso: string): boolean {
  return BY_DATE.has(iso);
}
