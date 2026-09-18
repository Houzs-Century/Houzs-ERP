// Month grid(s) for picking a date RANGE on the SO list filters. Presentation
// only: it reports yyyy-mm-dd strings and knows nothing about which column they
// filter. Monday-first, like the presets in the shared model. Two months side by
// side on desktop, one on a phone.
import { useState } from "react";
import { soAddDays, soIsYmd } from "../../vendor/shared/so-list-filter-model";

/* Names from Intl rather than typed lists: 2024-01-01 was a Monday. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).slice(0, 2));
const monthName = (first: string) =>
  new Date(`${first}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

const firstOfMonth = (ymd: string) => `${ymd.slice(0, 7)}-01`;
function shiftMonth(first: string, n: number): string {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

function monthCells(first: string): Array<string | null> {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1;
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let i = 0; i < days; i++) cells.push(soAddDays(first, i));
  return cells;
}

export function SoDateRangeCalendar({
  from,
  to,
  today,
  months,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  months: 1 | 2;
  onChange: (from: string, to: string) => void;
}) {
  const [anchor, setAnchor] = useState(() => firstOfMonth(soIsYmd(from) ? from : today));

  const pick = (day: string) => {
    if (!from || to) onChange(day, "");
    else if (day < from) onChange(day, "");
    else onChange(from, day);
  };

  return (
    <div data-testid="so-date-range-calendar" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" aria-label="Show previous month" onClick={() => setAnchor(shiftMonth(anchor, -1))} style={navBtn}>&lsaquo;</button>
        <button type="button" aria-label="Show next month" onClick={() => setAnchor(shiftMonth(anchor, 1))} style={navBtn}>&rsaquo;</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${months}, minmax(0, 1fr))`, gap: 14 }}>
        {Array.from({ length: months }, (_, i) => shiftMonth(anchor, i)).map((first) => (
          <div key={first}>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
              {monthName(first)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2 }}>
              {WEEKDAYS.map((w) => (
                <div key={w} style={{ textAlign: "center", fontSize: 10, color: "#8a8f84", padding: "2px 0" }}>{w}</div>
              ))}
              {monthCells(first).map((day, idx) => {
                if (!day) return <div key={`b${idx}`} />;
                const isEnd = day === from || day === to;
                const inRange = !!from && !!to && day > from && day < to;
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={day}
                    aria-pressed={isEnd}
                    onClick={() => pick(day)}
                    style={{
                      border: day === today ? "1px solid #16695f" : "1px solid transparent",
                      borderRadius: 7,
                      padding: "5px 0",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      background: isEnd ? "#16695f" : inRange ? "#dcefe9" : "transparent",
                      color: isEnd ? "#fff" : "#11140f",
                      fontWeight: isEnd ? 700 : 500,
                    }}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const navBtn = {
  border: "1px solid #d6d9d2",
  background: "#fff",
  borderRadius: 7,
  width: 28,
  height: 26,
  cursor: "pointer",
  fontSize: 16,
  lineHeight: "20px",
  fontFamily: "inherit",
} as const;
