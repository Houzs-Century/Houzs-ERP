/** The task role-badge rule, as one function instead of a copy per surface.
 *
 *  MIRRORS the backend original, `roleLabelAdmits` in
 *  `backend/src/services/projectGates.ts`, which every attach / status / review
 *  / delete route applies to a caller holding `projects.checklist.tick` but not
 *  `projects.write`: the badge admits the user when one of its "&"-separated
 *  parts equals their role, with DRIVER-badged field work also admitting
 *  HELPER and STOREKEEPER (no task is ever badged either of those, and the crew
 *  swap those jobs between themselves).
 *
 *  It lives here, not inline in `pages/Projects.tsx`, because the desktop is the
 *  third surface to need it — mobile keeps its own copy in `MobilePMS.tsx` —
 *  and because a rule of more than one term inlined in a 15,000-line component
 *  is how the desktop came to disagree with its own API twice (bugs 0546, 0628).
 */
export function roleLabelAdmitsRole(
  label: string | null | undefined,
  roleName: string | null | undefined,
): boolean {
  const r = (roleName ?? "").trim().toUpperCase();
  if (!r) return false;
  return (label ?? "")
    .toUpperCase()
    .split("&")
    .some((part) => {
      const l = part.trim();
      return !!l && (l === r || (l === "DRIVER" && (r === "HELPER" || r === "STOREKEEPER")));
    });
}
