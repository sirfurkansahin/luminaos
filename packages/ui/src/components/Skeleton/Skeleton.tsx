import { forwardRef } from 'react';

import styles from './Skeleton.module.css';

import type { CSSProperties, HTMLAttributes } from 'react';

export type SkeletonVariant = 'text' | 'rect' | 'circle';

export interface SkeletonProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'dangerouslySetInnerHTML'
> {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
}

function toDimension(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' ? `${value.toString()}px` : value;
}

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { variant = 'text', width, height, className, style, ...rest },
  ref,
) {
  const classNames = [styles.base, styles[variant], className].filter(Boolean).join(' ');
  const mergedStyle: CSSProperties = {
    ...style,
    width: toDimension(width),
    height: toDimension(height),
  };

  return (
    <div
      ref={ref}
      role="status"
      aria-busy="true"
      className={classNames}
      style={mergedStyle}
      {...rest}
    />
  );
});
