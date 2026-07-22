import { forwardRef } from 'react';

import styles from './Textarea.module.css';

import type { TextareaHTMLAttributes } from 'react';

export type TextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'dangerouslySetInnerHTML'
>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  const classNames = [styles.base, className].filter(Boolean).join(' ');
  return <textarea ref={ref} className={classNames} {...rest} />;
});
