/* Tailwind 3's space-x/space-y/divide-x/divide-y utilities select
     .space-y-2 > :not([hidden]) ~ :not([hidden])
   Chrome matches right to left, so it tries that `~` on EVERY element of the
   page and marks every parent (each <tbody>, each <tr>) as "children affected
   by a sibling rule". From then on, adding or removing one child restyles all
   the siblings after it, subtree included. A windowed table adds and removes
   rows on every scroll step, so each step restyled the whole table: measured
   on the 3,000-row Delivery Planning board, 154 ms per 10-row swap, against
   19 ms with this rewrite (perf-lab/tests/dp-board.desktop.spec.ts).

   `> :not([hidden]):not(:first-child)` styles the same children, with one
   difference: a FIRST child carrying the `hidden` attribute (not the `hidden`
   class) no longer stops the second child getting the gap. Tailwind 4 dropped
   the `~` form for the same reason. */
const FROM = ":not([hidden]) ~ :not([hidden])";
const TO = ":not([hidden]):not(:first-child)";

export function rewriteSiblingSelector(selector) {
  return selector.includes(FROM) ? selector.split(FROM).join(TO) : selector;
}

export default function siblingSpacing() {
  return {
    postcssPlugin: "houzs-sibling-spacing",
    Rule(rule) {
      const next = rewriteSiblingSelector(rule.selector);
      if (next !== rule.selector) rule.selector = next;
    },
  };
}
siblingSpacing.postcss = true;
