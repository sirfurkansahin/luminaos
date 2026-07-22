import { forwardRef } from 'react';

import styles from './Input.module.css';

import type { InputHTMLAttributes } from 'react';

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'dangerouslySetInnerHTML'>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  const classNames = [styles.base, className].filter(Boolean).join(' ');
  return <input ref={ref} className={classNames} {...rest} />;
});
