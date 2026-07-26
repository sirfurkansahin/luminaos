import { forwardRef } from 'react';

import styles from './EmptyState.module.css';

import type { HTMLAttributes, ReactNode } from 'react';

export interface EmptyStateProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'dangerouslySetInnerHTML' | 'title'
> {
  title: string;
  description?: string;
  action?: ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, action, className, ...rest },
  ref,
) {
  const classNames = [styles.base, className].filter(Boolean).join(' ');

  return (
    <div ref={ref} role="status" className={classNames} {...rest}>
      <h3 className={styles.title}>{title}</h3>
      {description !== undefined ? <p className={styles.description}>{description}</p> : null}
      {action !== undefined ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
});
