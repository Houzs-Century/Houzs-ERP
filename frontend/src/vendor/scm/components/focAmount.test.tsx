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
    render(<FocAmount line={{ unit_price_sen: 0, line_total_sen: 15_000 }} amount="RM 150.00" />);
    expect(screen.queryByText('FOC')).toBeNull();
    expect(screen.getByText('RM 150.00')).toBeTruthy();
  });
});
