import * as Checkbox from '@radix-ui/react-checkbox';
import { forwardRef } from 'react';

import styles from './Checkbox.module.css';

import type { ComponentPropsWithoutRef, ComponentRef } from 'react';

type RadixCheckboxProps = ComponentPropsWithoutRef<typeof Checkbox.Root>;

// `onCheckedChange` is widened to explicitly accept `| undefined` because
// callers routinely forward an optional handler prop of their own (typed
// `T | undefined` by TypeScript whenever a prop may be omitted) — under this
// repo's `exactOptionalPropertyTypes`, Radix's own (merely-optional) prop
// type rejects that. The cast below when spreading onto `Checkbox.Root`
// bridges back to Radix's type; `undefined` and "omitted" are equivalent at
// runtime for an optional callback prop.
export type CheckboxProps = Omit<
  RadixCheckboxProps,
  'dangerouslySetInnerHTML' | 'onCheckedChange'
> & {
  onCheckedChange?: RadixCheckboxProps['onCheckedChange'] | undefined;
};

export const CheckboxComponent = forwardRef<ComponentRef<typeof Checkbox.Root>, CheckboxProps>(
  function CheckboxComponent({ className, ...rest }, ref) {
    const classNames = [styles.root, className].filter(Boolean).join(' ');
    return (
      <Checkbox.Root ref={ref} className={classNames} {...(rest as RadixCheckboxProps)}>
        <Checkbox.Indicator className={styles.indicator}>✓</Checkbox.Indicator>
      </Checkbox.Root>
    );
  },
);

export { CheckboxComponent as Checkbox };
