/* Sample data for the HR redesign (handoff: layout is final, data wiring comes
 * later). Everything here is illustrative — no API, no real employees. */

export type Position = "driver" | "crew" | "supervisor";

/** Position accent → design-system token class. Lorry Driver = learning (blue),
 * Warehouse Crew = accent (brass), Supervisor = primary (petrol; the handoff's
 * forest green has no token yet — closest semantic match). */
export const POSITION: Record<Position, { label: string; dot: string; soft: string; text: string; bar: string }> = {
  driver: { label: "Lorry Driver", dot: "bg-learning", soft: "bg-learning-soft", text: "text-learning", bar: "bg-learning" },
  crew: { label: "Warehouse Crew", dot: "bg-accent", soft: "bg-accent-soft", text: "text-accent", bar: "bg-accent" },
  supervisor: { label: "Store Supervisor", dot: "bg-primary", soft: "bg-primary-soft", text: "text-primary", bar: "bg-primary" },
};

export type Punch = "on" | "late" | "out" | "leave";
export type Emp = { id: number; name: string; empNo: string; position: Position; punch: Punch; time: string | null };

export const EMPLOYEES: Emp[] = [
  { id: 1, name: "Mohd Faiz bin Rahman", empNo: "HC0012", position: "driver", punch: "on", time: "08:55" },
  { id: 2, name: "Shamsul Fiqri Bin Samsuddin", empNo: "HC0007", position: "driver", punch: "late", time: "09:18" },
  { id: 3, name: "Lim Chee Keong", empNo: "HC0003", position: "supervisor", punch: "on", time: "08:40" },
  { id: 4, name: "Mia Md Sagor", empNo: "HCFW006", position: "crew", punch: "late", time: "09:22" },
  { id: 5, name: "Amiuzzaman Shohag", empNo: "HCFW011", position: "crew", punch: "out", time: null },
  { id: 6, name: "Abdul Karim", empNo: "HCFW014", position: "crew", punch: "on", time: "08:58" },
  { id: 7, name: "Rahim Uddin", empNo: "HCFW009", position: "crew", punch: "on", time: "08:51" },
  { id: 8, name: "Tan Wei Sheng", empNo: "HC0021", position: "driver", punch: "on", time: "08:47" },
  { id: 9, name: "Jamal Hossain", empNo: "HCFW018", position: "crew", punch: "leave", time: null },
  { id: 10, name: "Nabil Haikal", empNo: "HC0025", position: "driver", punch: "on", time: "08:59" },
  { id: 11, name: "Sultan Mahmud", empNo: "HCFW022", position: "crew", punch: "late", time: "09:10" },
  { id: 12, name: "Chong Zi Xuan", empNo: "HC0030", position: "crew", punch: "on", time: "08:44" },
  { id: 13, name: "Ravi Kumar", empNo: "HC0031", position: "crew", punch: "on", time: "08:49" },
  { id: 14, name: "Hafiz Danial", empNo: "HCFW027", position: "crew", punch: "out", time: null },
  { id: 15, name: "Wong Jun Hao", empNo: "HC0034", position: "crew", punch: "on", time: "08:53" },
  { id: 16, name: "Arif Firdaus", empNo: "HC0036", position: "crew", punch: "on", time: "08:56" },
  { id: 17, name: "Suresh Nair", empNo: "HC0038", position: "crew", punch: "on", time: "08:52" },
];

export const ATTEND_DAYS: {
  date: number; dow: string; onTime: number; late: number; absent: number; today?: boolean;
  names: { late: string[]; absent: string[]; notin: string[]; leave: string[] };
}[] = [
  { date: 3, dow: "M", onTime: 82, late: 2, absent: 1, names: { late: ["Shamsul F.", "Mia S."], absent: ["Jamal H."], notin: [], leave: [] } },
  { date: 4, dow: "T", onTime: 76, late: 3, absent: 1, names: { late: ["Mia S.", "Sultan M.", "Rahim U."], absent: ["Hafiz D."], notin: [], leave: [] } },
  { date: 5, dow: "W", onTime: 94, late: 1, absent: 0, names: { late: ["Shamsul F."], absent: [], notin: [], leave: [] } },
  { date: 6, dow: "T", onTime: 53, late: 5, absent: 2, today: false, names: { late: ["Mia S.", "Sultan M.", "Shamsul F.", "Rahim U.", "Arif F."], absent: ["Jamal H.", "Hafiz D."], notin: [], leave: [] } },
  { date: 7, dow: "F", onTime: 82, late: 2, absent: 1, names: { late: ["Mia S.", "Sultan M."], absent: ["Jamal H."], notin: [], leave: [] } },
  { date: 10, dow: "M", onTime: 94, late: 1, absent: 0, names: { late: ["Shamsul F."], absent: [], notin: [], leave: [] } },
  { date: 11, dow: "T", onTime: 82, late: 2, absent: 1, names: { late: ["Mia S.", "Shamsul F."], absent: ["Hafiz D."], notin: [], leave: [] } },
  { date: 12, dow: "W", onTime: 88, late: 1, absent: 1, names: { late: ["Sultan M."], absent: ["Jamal H."], notin: [], leave: [] } },
  { date: 13, dow: "T", onTime: 100, late: 0, absent: 0, names: { late: [], absent: [], notin: [], leave: [] } },
  { date: 14, dow: "F", onTime: 65, late: 4, absent: 1, names: { late: ["Mia S.", "Sultan M.", "Shamsul F.", "Rahim U."], absent: ["Hafiz D."], notin: [], leave: [] } },
  { date: 17, dow: "M", onTime: 82, late: 2, absent: 1, names: { late: ["Mia S.", "Shamsul F."], absent: ["Jamal H."], notin: [], leave: [] } },
  { date: 18, dow: "T", onTime: 88, late: 1, absent: 1, names: { late: ["Sultan M."], absent: ["Hafiz D."], notin: [], leave: [] } },
  { date: 19, dow: "W", onTime: 76, late: 3, absent: 1, names: { late: ["Mia S.", "Sultan M.", "Rahim U."], absent: ["Jamal H."], notin: [], leave: [] } },
  { date: 20, dow: "T", onTime: 65, late: 3, absent: 2, today: true, names: { late: ["Mia S.", "Sultan M.", "Shamsul F."], absent: [], notin: ["Amiuzzaman S.", "Hafiz D."], leave: ["Jamal H."] } },
];

export const NEEDS_ATTENTION: { tone: "err" | "warning" | "primary" | "accent" | "learning"; title: string; sub: string; action: string; to: string }[] = [
  { tone: "err", title: "2 not punched in", sub: "Shamsul, Amiuzzaman · shift started", action: "View", to: "attendance" },
  { tone: "warning", title: "1 without ERP account", sub: "Amiuzzaman Shohag cannot punch in", action: "Link", to: "employees" },
  { tone: "err", title: "5 work permits expiring", sub: "Within 90 days · foreign workers", action: "Review", to: "employees" },
  { tone: "primary", title: "4 OT requests pending", sub: "Approve before payroll closes on 25 Nov", action: "Approve", to: "ot-requests" },
  { tone: "accent", title: "Payroll has 3 items to review", sub: "November run is still in draft", action: "Open", to: "payroll" },
  { tone: "learning", title: "3 on probation", sub: "Next confirmation in 86 days", action: "View", to: "employees" },
  { tone: "primary", title: "1 advance request pending", sub: "Submitted 18 Nov", action: "Approve", to: "advances" },
  { tone: "warning", title: "1 penalty disputed", sub: "Damaged sofa leg during delivery", action: "Review", to: "penalties" },
];

export const COMING_UP: { day: string; mon: string; label: string; kind: string; tone: "accent" | "err" | "primary" | "learning" }[] = [
  { day: "30", mon: "NOV", label: "November pay date", kind: "Payroll", tone: "accent" },
  { day: "11", mon: "DEC", label: "Sultan of Selangor's Birthday", kind: "Holiday", tone: "err" },
  { day: "25", mon: "DEC", label: "Christmas Day", kind: "Holiday", tone: "err" },
  { day: "02", mon: "JAN", label: "Abdul Karim — probation ends", kind: "Probation", tone: "primary" },
  { day: "15", mon: "JAN", label: "Mia Sagor — permit renewal", kind: "Permit", tone: "learning" },
];

export const MOST_LATE: { name: string; position: Position; count: number }[] = [
  { name: "Mia Md Sagor", position: "crew", count: 4 },
  { name: "Shamsul Fiqri Bin Samsuddin", position: "driver", count: 3 },
  { name: "Sultan Mahmud", position: "crew", count: 3 },
  { name: "Rahim Uddin", position: "crew", count: 2 },
  { name: "Arif Firdaus", position: "crew", count: 1 },
  { name: "Hafiz Danial", position: "crew", count: 1 },
];

/** Deterministic avatar colour from a name. */
const AVATAR_BG = ["bg-primary", "bg-accent", "bg-learning", "bg-synced", "bg-err"];
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_BG[h % AVATAR_BG.length];
}
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
