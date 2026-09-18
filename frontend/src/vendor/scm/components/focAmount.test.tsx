/* FOC on the PURCHASE side.
 *
 * The owner asked for the free-of-charge marker on every document. Before this,
 * three had it (sales order, delivery order, sales invoice) and three did not
 * (purchase order, goods receipt, purchase invoice) — so a supplier freebie
 * printed as RM 0.00 with nothing to say it was meant to be zero, and the same
 * goods carried a FOC badge once they reached the customer's delivery order.
 *
 * These pin the two things that can go wrong in the cell itself; the RULE for
 * what counts as free is tested once, in foc-line.test.ts, and deliberately not
 * re-asserted here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FocAmount } from './FocAmount';

afterEach(cleanup);

describe('FocAmount', () => {
  it('says FOC instead of printing a zero that looks like missing data', () => {
    render(<FocAmount line={{ unit_price_sen: 0, line_total_sen: 0 }} amount="RM 0.00" />);
    expect(screen.getByText('FOC')).toBeTruthy();
    expect(screen.queryByText('RM 0.00')).toBeNull();
  });

  it('prints the money the host page formatted, in that document currency', () => {
    /* The component never formats: each page formats in its own document
       currency, and a component that guessed would print MYR on a USD PO. */
    render(<FocAmount line={{ unit_price_sen: 25_000, line_total_sen: 25_000 }} amount="USD 250.00" />);
    expect(screen.getByText('USD 250.00')).toBeTruthy();
    expect(screen.queryByText('FOC')).toBeNull();
  });

  it('keeps the sub-line under a charged amount — the goods receipt prints freight there', () => {
    render(
      <FocAmount
        line={{ unit_price_sen: 25_000, line_total_sen: 25_000 }}
        amount="RM 250.00"
        sub={<span>incl. RM 12.00 freight</span>}
      />,
    );
    expect(screen.getByText('RM 250.00')).toBeTruthy();
    expect(screen.getByText('incl. RM 12.00 freight')).toBeTruthy();
  });

  it('drops the sub-line on a FREE line, so freight cannot contradict the badge', () => {
    /* A freebie that carries allocated freight still cost nothing to BUY, which
       is what the badge claims. Printing "FOC" beside "incl. RM 12.00 freight"
       reads as two answers to one question. */
    render(
      <FocAmount
        line={{ unit_price_sen: 0, line_total_sen: 0 }}
        amount="RM 0.00"
        sub={<span>incl. RM 12.00 freight</span>}
      />,
    );
    expect(screen.getByText('FOC')).toBeTruthy();
    expect(screen.queryByText('incl. RM 12.00 freight')).toBeNull();
  });

  it('a line priced at zero that still takes money is NOT free', () => {
    /* The half the delivery order was missing before foc-line.ts. Asserted here
       too because this cell is where a reader would see the wrong answer. */
    render(<FocAmount line={{ unit_price_sen: 0, line_total_sen: 15_000 }} amount="RM 150.00" />);
    expect(screen.queryByText('FOC')).toBeNull();
    expect(screen.getByText('RM 150.00')).toBeTruthy();
  });
});
