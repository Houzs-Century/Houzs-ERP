import { ExpandableText } from "autocount-sync-frontend";

// Line-clamped text block with a "Show more" toggle — remarks and
// complaint descriptions in detail panels.

const LONG =
  "Customer reported water dripping from the indoor unit after last week's " +
  "service visit. Technician found the drain pipe partially blocked and the " +
  "insulation foam degraded near the joint. Recommended full drain-pipe " +
  "replacement plus re-gassing; customer wants a quotation before we proceed " +
  "and prefers a weekend appointment after 2pm.";

export const ClampedTwoLines = () => (
  <div className="w-80 text-[12.5px] leading-relaxed text-ink-secondary">
    <ExpandableText text={LONG} />
  </div>
);

export const ClampedThreeLines = () => (
  <div className="w-80 text-[12.5px] leading-relaxed text-ink-secondary">
    <ExpandableText text={LONG} lines={3} />
  </div>
);

export const ShortNoToggle = () => (
  <div className="w-80 text-[12.5px] leading-relaxed text-ink-secondary">
    <ExpandableText text="Unit replaced under warranty. Case closed." />
  </div>
);

export const Empty = () => (
  <div className="w-80 text-[12.5px]">
    <ExpandableText text={null} emptyLabel="No remarks" />
  </div>
);
