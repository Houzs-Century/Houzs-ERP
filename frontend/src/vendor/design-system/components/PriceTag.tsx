import { type HTMLAttributes } from 'react';
import clsx from '../clsx';
import styles from './PriceTag.module.css';

export interface PriceTagProps extends HTMLAttributes<HTMLSpanElement> {
  /** Whole-MYR amount. NEVER pass a fractional value. §10 Decision 9: integer RM only, never `.00`. */
  amount: number;
  size?: 'sm' | 'md' | 'lg' | 'hero';
  /** When false, hides the "RM" prefix (use when context already shows currency). Default: true. */
  withCurrency?: boolean;
}

const fmtMYR = (n: number): string =>
  n.toLocaleString('en-MY', { maximumFractionDigits: 0 });

export const PriceTag = ({
  amount,
  size = 'md',
  withCurrency = true,
  className,
  ...rest
}: PriceTagProps) => (
  <span className={clsx(styles.priceTag, styles[`size-${size}`], className)} {...rest}>
    {withCurrency && <span className={styles.currency}>RM</span>}
    <span className={styles.amount}>{fmtMYR(amount)}</span>
  </span>
);
