import { forwardRef } from 'react';

import styles from './Badge.module.css';

import type { HTMLAttributes } from 'react';

export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  'dangerouslySetInnerHTML'
> {
  variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', className, ...rest },
  ref,
) {
  const classNames = [styles.base, styles[variant], className].filter(Boolean).join(' ');
  return <span ref={ref} className={classNames} {...rest} />;
});
