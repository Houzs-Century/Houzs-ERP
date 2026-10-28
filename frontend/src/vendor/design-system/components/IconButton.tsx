import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import clsx from '../clsx';
import styles from './IconButton.module.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Required: screen-reader description (icons have no text) */
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, variant = 'ghost', size = 'md', type = 'button', className, ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={clsx(
        styles.iconButton,
        styles[`variant-${variant}`],
        styles[`size-${size}`],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  ),
);
IconButton.displayName = 'IconButton';
