// The office side of a public calendar share link, for the Project Maintenance
// row menus: copy (get-or-create) the link, or revoke it. One module for both
// kinds so the contractor and brand rows cannot drift apart — the only things
// that differ are the admin endpoint and the public path prefix.
//
//   contractor  POST/DELETE /api/projects/contractors/:id/share-link  →  /c/<token>
//   brand       POST/DELETE /api/brand-share/:id/share-link           →  /b/<token>
import { api } from "../../api/client";
import type { useDialog } from "../../hooks/useDialog";
import type { useToast } from "../../hooks/useToast";

export type ShareKind = "contractor" | "brand";
type Row = { id: number; name: string };
type Toast = ReturnType<typeof useToast>;
type Dialog = ReturnType<typeof useDialog>;

const ADMIN_PATH: Record<ShareKind, (id: number) => string> = {
  contractor: (id) => `/api/projects/contractors/${id}/share-link`,
  brand: (id) => `/api/brand-share/${id}/share-link`,
};
const PUBLIC_PREFIX: Record<ShareKind, string> = { contractor: "c", brand: "b" };

/** Generate (or reuse) the link and put it on the clipboard, ready to paste
 *  into WhatsApp. A contractor's link shows their confirmed events + booth
 *  numbers + blank floorplans; a brand's shows its own events + display
 *  floorplan + size + total sales (pages/ShareCalendar.tsx). */
export async function copyShareLink(kind: ShareKind, row: Row, toast: Toast): Promise<void> {
  try {
    const res = await api.post<{ token: string }>(ADMIN_PATH[kind](row.id));
    const url = `${window.location.origin}/${PUBLIC_PREFIX[kind]}/${res.token}`;
    await navigator.clipboard.writeText(url);
    toast.success(`Share link for ${row.name} copied`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Could not create the share link.");
  }
}

/** What one press of Export on a CONTRACTOR's link covers: the month on screen
 *  or the whole year (owner 2026-09-09: three contractors export the year, the
 *  rest the month). Brands always export the month. */
export async function setShareExportScope(row: Row, scope: "month" | "year", toast: Toast, reload: () => void): Promise<void> {
  try {
    await api.patch(`/api/projects/contractors/${row.id}`, { share_export_scope: scope });
    reload();
    toast.success(scope === "year" ? `${row.name}'s link now exports the whole year` : `${row.name}'s link now exports the month on screen`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Could not update the export setting.");
  }
}

/** Kill the current link (leaked, or the wrong party). A fresh one can be
 *  generated any time by copying again. */
export async function revokeShareLink(kind: ShareKind, row: Row, toast: Toast, dialog: Dialog): Promise<void> {
  if (
    !(await dialog.confirm({
      title: "Revoke share link",
      message: `Revoke ${row.name}'s calendar link? Anyone holding the old link loses access. Copy the link again to issue a new one.`,
      danger: true,
      confirmLabel: "Revoke",
    }))
  )
    return;
  try {
    await api.del(ADMIN_PATH[kind](row.id));
    toast.success("Share link revoked");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Could not revoke the share link.");
  }
}
