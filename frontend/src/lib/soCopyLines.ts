/* Copy as new (HC-0149): a PWP reward line is only valid with its single-use code
   (variants.pwp + variants.pwpCode). While the source order is live the code is USED
   on it, so copying the line makes the server refuse the save (409 pwp_code_rejected).
   A line without a code would be repriced to full price, so the reward line is left
   out and the operator re-adds it with a new code. A CANCELLED source (convert flow)
   has released its codes, so its lines are copied untouched. */
export const isPwpRewardLine = (it: { variants?: unknown }): boolean => {
  const v = (it.variants ?? {}) as { pwp?: unknown; pwpCode?: unknown };
  return Boolean(v.pwp) || String(v.pwpCode ?? '').trim() !== '';
};

export function copyLinesWithoutPwp<T extends { variants?: unknown }>(
  items: T[], sourceStatus?: string | null,
): { kept: T[]; dropped: number } {
  if (sourceStatus === 'CANCELLED') return { kept: items, dropped: 0 };
  const kept = items.filter((it) => !isPwpRewardLine(it));
  return { kept, dropped: items.length - kept.length };
}

export const pwpDroppedNotice = (n: number): string =>
  `${n} PWP line(s) left out - re-add with a new code`;

/* Call-site entry for the SO desktop and mobile copy seeds: live (non-cancelled) lines, PWP rewards
   left out, and the operator told when any were. */
export function copySeedLines<T extends { variants?: unknown; cancelled?: unknown }>(
  items: T[] | null | undefined, sourceStatus: string | null | undefined,
  notify: (n: { title: string; body: string }) => unknown,
): T[] {
  const { kept, dropped } = copyLinesWithoutPwp((items ?? []).filter((it) => !it.cancelled), sourceStatus);
  if (dropped > 0) notify({ title: 'PWP line left out', body: pwpDroppedNotice(dropped) });
  return kept;
}
