import { cn } from "../lib/utils";

/* ----------------------------------------------------------------------------
   NextStepNote — the VISIBLE half of "the control stays, disabled, carrying the
   reason".

   WHY A COMPONENT AND NOT A `title=`. The first pass at this rule delivered the
   reason through the button's `title` attribute alone. A `title` tooltip needs a
   HOVER, and a phone has no hover — so on the surface where the operator is most
   likely to be standing in front of the goods (the md:hidden action bar, the
   native mobile shell), the disabled button explained itself to nobody. That
   reproduces the exact defect this rule exists to end: the capability is on
   screen and still says nothing about why it is off.

   So the reason renders as TEXT. The control keeps `title` too — it costs
   nothing and is a pleasant desktop affordance — but the text is the contract.

   ACCESSIBILITY. Pass the same `id` to the note and to the control's
   `aria-describedby`, so a screen reader announces the disabled button together
   with the sentence that explains it. A disabled <button> is still reachable by
   screen readers in browse mode, so the description is read.

   Nothing here decides WHAT the sentence is. Each document family owns its own
   wording in one module (vendor/scm/lib/do-next-step.ts is the first), and this
   component only puts it on the screen.
   ---------------------------------------------------------------------------- */

export function NextStepNote({
  id,
  reason,
  className,
}: {
  /** Must match the `aria-describedby` on the control this explains. */
  id: string;
  /** The sentence, or `null` when the control is available (renders nothing). */
  reason: string | null | undefined;
  className?: string;
}) {
  if (!reason) return null;
  return (
    <p
      id={id}
      className={cn(
        "text-[11.5px] leading-snug text-ink-muted",
        className
      )}
    >
      {reason}
    </p>
  );
}
