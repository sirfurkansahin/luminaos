import { forwardRef } from 'react';

import styles from './Card.module.css';

import type { HTMLAttributes } from 'react';

export type CardProps = Omit<HTMLAttributes<HTMLDivElement>, 'dangerouslySetInnerHTML'>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...rest },
  ref,
) {
  const classNames = [styles.base, className].filter(Boolean).join(' ');
  return <div ref={ref} className={classNames} {...rest} />;
});
