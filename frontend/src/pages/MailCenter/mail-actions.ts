// ---------------------------------------------------------------------------
// Mail Center — shared mutation helpers for thread actions.
//
// These wrap the backend thread-mutation endpoint:
//   PATCH /api/mail-center/threads/:id
// which accepts status (open/closed), assignedTo*, and the email-client
// affordances starred / labels / unread / trashed (all DB-backed). The list
// rows, bulk action bar and reading pane all post the same way.
//
// Houzs cache invalidation: the shared api client (api/client.ts) invalidates
// the WHOLE resource family on every mutation — invalidateForMutation matches
// the first path segment, so any PATCH/POST/DELETE under `/api/mail-center/*`
// clears every cached `/api/mail-center*` GET (threads list, single thread,
// addresses, labels) in this tab and, via BroadcastChannel, every other tab.
// So we don't hand-invalidate per-prefix the way Hookka did — the client does
// it for us. Only compose DRAFTS remain local (mail-local.ts).
// ---------------------------------------------------------------------------
import { api } from "../../api/client";

// Generic single-thread PATCH used by the star / label / unread / trash helpers
// below. Posts an arbitrary subset of the mutable fields. Returns true on success.
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

// Star / unstar a single thread (DB-backed). Returns true on success.
export async function patchThreadStarred(
  id: string,
  starred: boolean,
): Promise<boolean> {
  return patchThread(id, { starred });
}

// Replace a thread's label set (DB-backed JSON array). Returns true on success.
export async function patchThreadLabels(
  id: string,
  labels: string[],
): Promise<boolean> {
  return patchThread(id, { labels });
}

// Mark a thread read (unread=false) / unread (unread=true). This is the only
// path that can SET unread back on — GET /threads/:id clears it on open.
export async function patchThreadUnread(
  id: string,
  unread: boolean,
): Promise<boolean> {
  return patchThread(id, { unread });
}

// Move a thread to Trash (trashed=true) / restore it (trashed=false), DB-backed
// soft delete. Returns true on success.
export async function patchThreadTrashed(
  id: string,
  trashed: boolean,
): Promise<boolean> {
  return patchThread(id, { trashed });
}

// Bulk variants — sequential (Hyperdrive throttles bursts; these lists are a
// handful of selected rows). Each resolves with the count that succeeded so
// callers can report partial failures honestly.
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

// PATCH a single thread's status (open = Inbox, closed = Done/Archive).
export async function patchThreadStatus(
  id: string,
  status: "open" | "closed",
): Promise<boolean> {
  return patchThread(id, { status });
}

// Set status on many threads (bulk archive / move-to-inbox). Resolves with the
// count that succeeded. Sequential on purpose (Hyperdrive throttles bursts).
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

// Assign / unassign a single thread.
export async function patchThreadAssignment(
  id: string,
  assignedToUserId: string | number | null,
  assignedToName: string | null,
): Promise<boolean> {
  return patchThread(id, { assignedToUserId, assignedToName });
}

// Apply ONE label name to many threads (bulk label). Merges the name into each
// thread's existing set (case-insensitive, no duplicates). Resolves with the
// count that succeeded. `items` maps threadId → its existing label names.
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

// ── Label catalogue (name → colour) ────────────────────────────────────────
// The per-thread label SET still lives on email_threads.labels; this catalogue
// only carries colours + the canonical managed list. A rename cascades
// server-side into the thread label arrays; the shared client invalidation
// refreshes the list rows so the new name shows.

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

// ── Department / shared mailbox provisioning ───────────────────────────────
// Admin one-click setup for a SHARED department mailbox (support@/finance@/hr@):
// reuses POST /api/mail-center/addresses (the same endpoint User Management
// uses), creating an address row with an assignedDept and NO assigned user.
// Returns the new address id on success, or null on failure / 403 (non-admin).
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
// address `id` is text. The department picker sends the dept NAME string (the
// backend string-matches assigned_dept), never an id.

// One mailbox address row as served by GET /api/mail-center/addresses.
export type MailAddress = {
  id: string;
  address: string;
  label: string;
  assignedUserId?: number | null;
  assignedUserName?: string;
  assignedDept?: string;
  assignedPosition?: string;
  active: boolean;
  createdAt?: string;
};

export type MailScopeLevel = "personal" | "department" | "company";

export type CreateAddressInput = {
  label?: string;
  assignedUserId?: number | null;
  assignedUserName?: string;
  assignedDept?: string;
  assignedPosition?: string;
};

// Management list (MailboxesTab): every mailbox, for assigning to people.
// ?manage=1 makes a mail admin get ALL; the sidebar / Compose call the plain
// endpoint and stay scope-bound (per-user isolation). GET is no-store server-side.
export function fetchAddresses(): Promise<MailAddress[]> {
  return api.get<MailAddress[]>("/api/mail-center/addresses?manage=1");
}

// Create a mailbox — for a PERSON (pass assignedUserId + assignedUserName) or a
// DEPARTMENT (pass assignedDept = the dept NAME + a label, no user). Returns the
// created row. Throws on 400 (bad/duplicate domain) / 409 (exists) / 403.
export function createAddress(
  address: string,
  input: CreateAddressInput = {},
): Promise<MailAddress> {
  return api.post<MailAddress>("/api/mail-center/addresses", {
    address,
    ...input,
  });
}

// Patch a mailbox (reassign / relabel / toggle active). Send only changed
// fields. `active` is a boolean (backend maps to 1/0).
export function patchAddress(
  id: string,
  patch: {
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string | null;
    assignedDept?: string | null;
    assignedPosition?: string | null;
    active?: boolean;
  },
): Promise<MailAddress> {
  return api.patch<MailAddress>(`/api/mail-center/addresses/${id}`, patch);
}

// The access matrix — every (addressId, userId) grant on a shared mailbox.
export function fetchAccess(): Promise<{ addressId: string; userId: number }[]> {
  return api.get<{ addressId: string; userId: number }[]>(
    "/api/mail-center/access",
  );
}

// Grant a user access to a shared mailbox (idempotent server-side).
export function grantAccess(addressId: string, userId: number): Promise<unknown> {
  return api.post("/api/mail-center/access", { addressId, userId });
}

// Revoke a user's access to a shared mailbox.
export function revokeAccess(
  addressId: string,
  userId: number,
): Promise<unknown> {
  // api.del takes no body, so pass addressId/userId on the query string — the
  // DELETE /access handler accepts either body or query.
  const qs = `addressId=${encodeURIComponent(addressId)}&userId=${userId}`;
  return api.del(`/api/mail-center/access?${qs}`);
}

// Per-user visibility levels (personal / department / company). Absent = personal.
export function fetchScopeLevels(): Promise<
  { userId: number; level: MailScopeLevel }[]
> {
  return api.get<{ userId: number; level: MailScopeLevel }[]>(
    "/api/mail-center/scope-levels",
  );
}

// ── Auto-sent outbox (read-only) ───────────────────────────────────────────
// The system's auto-sent customer notices (Delivery Order, Invoice, etc.) go
// out from a noreply sender, so there's no human "Sent" copy to read. The
// "Auto-sent" folder lists this outbound log. These are READ-only fetchers —
// the outbox is written by the backend dispatcher, never the client.

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

// List the auto-sent outbound log. Optional status filter (SENT/FAILED/PENDING)
// + free-text query + pagination.
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

// Fetch one auto-sent email's full body + metadata for the reader modal.
export function fetchOutboxDetail(id: string): Promise<OutboxDetail> {
  return api.get<OutboxDetail>(
    `/api/mail-center/outbox/${encodeURIComponent(id)}`,
  );
}

// Upsert a user's visibility level. Note the singular path (write) vs the plural
// GET /scope-levels (list).
export function setScopeLevel(
  userId: number,
  level: MailScopeLevel,
): Promise<unknown> {
  return api.put("/api/mail-center/scope-level", { userId, level });
}
