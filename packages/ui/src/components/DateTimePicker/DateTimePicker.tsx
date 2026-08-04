import { forwardRef } from 'react';

import styles from './DateTimePicker.module.css';

import type { InputHTMLAttributes } from 'react';

export interface DateTimePickerProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'dangerouslySetInnerHTML'
> {
  mode?: 'date' | 'datetime-local';
}

export const DateTimePicker = forwardRef<HTMLInputElement, DateTimePickerProps>(
  function DateTimePicker({ className, mode, ...rest }, ref) {
    const classNames = [styles.base, className].filter(Boolean).join(' ');
    return <input ref={ref} type={mode ?? 'datetime-local'} className={classNames} {...rest} />;
  },
);
