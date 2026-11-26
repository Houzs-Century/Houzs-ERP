import { api } from "../../api/client";

type ThreadPatch = {
  status?: "open" | "closed";
  assignedToUserId?: string | number | null;
  assignedToName?: string | null;
  starred?: boolean;
  labels?: string[];
  unread?: boolean;
  trashed?: boolean;
};

async function patchThread(id: string, patch: ThreadPatch): Promise<boolean> {
  try {
    await api.patch(`/api/mail-center/threads/${id}`, patch);
    return true;
  } catch {
    return false;
  }
}

export async function patchThreadStarred(
  id: string,
  starred: boolean,
): Promise<boolean> {
  return patchThread(id, { starred });
}

export async function patchThreadLabels(
  id: string,
  labels: string[],
): Promise<boolean> {
  return patchThread(id, { labels });
}

export async function patchThreadUnread(
  id: string,
  unread: boolean,
): Promise<boolean> {
  return patchThread(id, { unread });
}

export async function patchThreadTrashed(
  id: string,
  trashed: boolean,
): Promise<boolean> {
  return patchThread(id, { trashed });
}

export async function patchManyUnread(
  ids: string[],
  unread: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadUnread(id, unread)) ok++;
  }
  return ok;
}

export async function patchManyTrashed(
  ids: string[],
  trashed: boolean,
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadTrashed(id, trashed)) ok++;
  }
  return ok;
}

export async function patchThreadStatus(
  id: string,
  status: "open" | "closed",
): Promise<boolean> {
  return patchThread(id, { status });
}

export async function patchManyStatus(
  ids: string[],
  status: "open" | "closed",
): Promise<number> {
  let ok = 0;
  for (const id of ids) {
    if (await patchThreadStatus(id, status)) ok++;
  }
  return ok;
}

export async function patchThreadAssignment(
  id: string,
  assignedToUserId: string | number | null,
  assignedToName: string | null,
): Promise<boolean> {
  return patchThread(id, { assignedToUserId, assignedToName });
}

export async function patchManyAddLabel(
  items: { id: string; labels: string[] }[],
  name: string,
): Promise<number> {
  const clean = name.trim();
  if (!clean) return 0;
  let ok = 0;
  for (const it of items) {
    const has = it.labels.some((l) => l.toLowerCase() === clean.toLowerCase());
    const next = has ? it.labels : [...it.labels, clean];
    if (await patchThreadLabels(it.id, next)) ok++;
  }
  return ok;
}


export async function createLabel(
  name: string,
  color: string,
): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  try {
    await api.post("/api/mail-center/labels", { name: clean, color });
    return true;
  } catch {
    return false;
  }
}

export async function updateLabel(
  id: string,
  patch: { name?: string; color?: string },
): Promise<boolean> {
  try {
    await api.patch(`/api/mail-center/labels/${id}`, patch);
    return true;
  } catch {
    return false;
  }
}

export async function deleteLabel(id: string): Promise<boolean> {
  try {
    await api.del(`/api/mail-center/labels/${id}`);
    return true;
  } catch {
    return false;
  }
}

export async function createDeptMailbox(
  address: string,
  dept: string,
  label: string,
): Promise<string | null> {
  try {
    const body = await api.post<{ id?: string }>("/api/mail-center/addresses", {
      address,
      assignedDept: dept,
      label,
    });
    return body?.id ?? "";
  } catch {
    return null;
  }
}

// ── Mail Center admin helpers (User Management → Mailboxes tab) ─────────────
// Thin typed wrappers over the admin endpoints in routes/mail-center.ts. All
// gated server-side on mail_center.manage (owner via "*"). These THROW on
// failure so the calling tab can toast a real message (unlike the boolean
// thread helpers above) — the tab needs to know WHY a save failed (409 dup,
// 400 bad domain, 403 not-admin).
//
// userId / assignedUserId are NUMBERS in Houzs (users.id is serial); the
// address `id` is text. A department mailbox is linked to its Org Chart
// department by `departmentId` (HC-0157); a bare name is resolved server-side.

export type MailAddress = {
  id: string;
  address: string;
  label: string;
  assignedUserId?: number | null;
  assignedUserName?: string;
  assignedDept?: string;
  departmentId?: number | null;
  assignedPosition?: string;
  ownerDepartmentId?: number | null;
  ownerDepartmentName?: string | null;
  active: boolean;
  createdAt?: string;
};

/* department = the department mailboxes of every Org Chart department the person
   is in; department_all adds those departments' colleagues' own mailboxes
   (a manager, owner 2026-11-21). */
export type MailScopeLevel = "personal" | "department" | "department_all" | "company";

export const DEFAULT_MAIL_SCOPE_LEVEL: MailScopeLevel = "department";

export type CreateAddressInput = {
  label?: string;
  assignedUserId?: number | null;
  assignedUserName?: string;
  assignedDept?: string;
  departmentId?: number | null;
  assignedPosition?: string;
};

export function fetchAddresses(): Promise<MailAddress[]> {
  return api.get<MailAddress[]>("/api/mail-center/addresses?manage=1");
}

export function createAddress(
  address: string,
  input: CreateAddressInput = {},
): Promise<MailAddress> {
  return api.post<MailAddress>("/api/mail-center/addresses", {
    address,
    ...input,
  });
}

export function patchAddress(
  id: string,
  patch: {
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string | null;
    assignedDept?: string | null;
    departmentId?: number | null;
    assignedPosition?: string | null;
    active?: boolean;
  },
): Promise<MailAddress> {
  return api.patch<MailAddress>(`/api/mail-center/addresses/${id}`, patch);
}

export function fetchAccess(): Promise<{ addressId: string; userId: number }[]> {
  return api.get<{ addressId: string; userId: number }[]>(
    "/api/mail-center/access",
  );
}

export function grantAccess(addressId: string, userId: number): Promise<unknown> {
  return api.post("/api/mail-center/access", { addressId, userId });
}

export function revokeAccess(
  addressId: string,
  userId: number,
): Promise<unknown> {
  const qs = `addressId=${encodeURIComponent(addressId)}&userId=${userId}`;
  return api.del(`/api/mail-center/access?${qs}`);
}

export function fetchScopeLevels(): Promise<
  { userId: number; level: MailScopeLevel }[]
> {
  return api.get<{ userId: number; level: MailScopeLevel }[]>(
    "/api/mail-center/scope-levels",
  );
}


export type OutboxRow = {
  id: string;
  toAddress: string;
  subject: string;
  status: "SENT" | "FAILED" | "PENDING";
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  snippet: string;
  attachmentNames: string[];
};

export type OutboxCounts = { sent: number; failed: number; pending: number };

export type OutboxList = {
  rows: OutboxRow[];
  counts: OutboxCounts;
  hasMore: boolean;
};

export type OutboxDetail = {
  id: string;
  toAddress: string;
  subject: string;
  status: "SENT" | "FAILED" | "PENDING";
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  bodyHtml: string;
  bodyText: string;
  attachmentNames: string[];
};

export function fetchOutbox(opts: {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<OutboxList> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.q) params.set("q", opts.q);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return api.get<OutboxList>(`/api/mail-center/outbox${qs}`);
}

export function fetchOutboxDetail(id: string): Promise<OutboxDetail> {
  return api.get<OutboxDetail>(
    `/api/mail-center/outbox/${encodeURIComponent(id)}`,
  );
}

export function setScopeLevel(
  userId: number,
  level: MailScopeLevel,
): Promise<unknown> {
  return api.put("/api/mail-center/scope-level", { userId, level });
}

// L2 people: the OTHER departments ticked for them (owner 2026-11-21).
export function fetchScopeDepartments(): Promise<{ userId: number; departmentId: number }[]> {
  return api.get<{ userId: number; departmentId: number }[]>("/api/mail-center/scope-departments");
}

export function setScopeDepartments(userId: number, departmentIds: number[]): Promise<unknown> {
  return api.put("/api/mail-center/scope-departments", { userId, departmentIds });
}

export type MailboxSync = { address: string; pending: boolean; lastInboundAt: string | null; threads: number };

export function fetchSyncStatus(): Promise<MailboxSync[]> {
  return api.get<MailboxSync[]>("/api/mail-center/sync-status");
}
