import { forwardRef } from 'react';

import styles from './Button.module.css';

import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'dangerouslySetInnerHTML'
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  const classNames = [styles.base, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(' ');

  return <button ref={ref} className={classNames} {...rest} />;
});
