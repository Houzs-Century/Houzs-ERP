
---

## FOC on the line grid

A line that charges nothing shows **FOC** in its Amount cell instead of RM 0.00,
rendered by `FocAmount` (`frontend/src/vendor/scm/components/FocAmount.tsx`) over
the one shared rule, `isFocLine`.

The badge sits in the AMOUNT cell here and in the DISCOUNT cell on the sales
order, delivery order and sales invoice. That is deliberate, not drift: the three
sales documents have a Discount column on their line grid and the three purchase
documents do not. The underlying tables all store a discount; these grids do not
read it.

The allocated-freight sub-line is dropped on a free line — a freebie that carries
landed cost still cost nothing to buy, and printing both reads as two answers to
one question. Trace:
`docs/bugs/0849-a-supplier-freebie-printed-as-rm-0-00-with-nothing-to-say-it.md`.
