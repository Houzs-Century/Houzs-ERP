// Personal mail (DEV-03 P3): the default company address and the shape of
// GET /api/mail-center/visibility. The default mirrors the server's
// defaultPersonalLocalPart (backend/src/lib/mail-provision.ts); the server
// still picks the final address and adds a number when it is taken.

export function defaultPersonalLocalPart(name: string | null | undefined): string | null {
  const words = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.length === 1 ? words[0] : `${words[0]}.${words[words.length - 1]}`;
}

export function mailDomainOf(companyEmail: string): string {
  return (companyEmail.split("@")[1] || "houzscentury.com").trim().toLowerCase();
}

export type MailReach = "own" | "granted" | "department" | "company";

export type MailVisibility = {
  level: string;
  manage: boolean;
  myAddress: string | null;
  mailboxes: Array<{ address: string; label: string; reach: MailReach }>;
  sendFrom: string[];
};

export const REACH_LABEL: Record<MailReach, string> = {
  own: "Yours",
  granted: "Shared with you",
  department: "Your department",
  company: "Whole company",
};

export const LEVEL_LABEL: Record<string, string> = {
  personal: "Your own and shared mailboxes",
  department: "Plus every mailbox in your department",
  company: "Every mailbox in the company",
};
