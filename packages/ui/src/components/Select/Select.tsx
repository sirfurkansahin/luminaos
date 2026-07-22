import * as Select from '@radix-ui/react-select';
import { forwardRef } from 'react';

import styles from './Select.module.css';

import type { ComponentProps, ComponentPropsWithoutRef, ComponentRef, ComponentType } from 'react';

type RadixSelectRootProps = ComponentProps<typeof Select.Root>;

// `Select.Root` has no DOM output of its own, so it is re-exported as-is
// (per the shadcn/ui pattern) rather than wrapped. `onValueChange` is widened
// to explicitly accept `| undefined` because callers routinely forward an
// optional handler prop of their own (typed `T | undefined` whenever a prop
// may be omitted) — under this repo's `exactOptionalPropertyTypes`, Radix's
// own (merely-optional) prop type rejects that. This is a type-only
// re-annotation of the same function reference; runtime behavior is
// unchanged.
export type SelectRootProps = Omit<RadixSelectRootProps, 'onValueChange'> & {
  onValueChange?: RadixSelectRootProps['onValueChange'] | undefined;
};

export const SelectRoot = Select.Root as unknown as ComponentType<SelectRootProps>;

export type SelectTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof Select.Trigger>,
  'dangerouslySetInnerHTML'
>;

export const SelectTrigger = forwardRef<ComponentRef<typeof Select.Trigger>, SelectTriggerProps>(
  function SelectTrigger({ className, children, ...rest }, ref) {
    const classNames = [styles.trigger, className].filter(Boolean).join(' ');
    return (
      <Select.Trigger ref={ref} className={classNames} {...rest}>
        {children}
        <Select.Icon className={styles.icon} aria-hidden="true">
          ▾
        </Select.Icon>
      </Select.Trigger>
    );
  },
);

export type SelectValueProps = Omit<
  ComponentPropsWithoutRef<typeof Select.Value>,
  'dangerouslySetInnerHTML'
>;

export const SelectValue = forwardRef<ComponentRef<typeof Select.Value>, SelectValueProps>(
  function SelectValue({ className, ...rest }, ref) {
    const classNames = [styles.value, className].filter(Boolean).join(' ');
    return <Select.Value ref={ref} className={classNames} {...rest} />;
  },
);

export type SelectContentProps = Omit<
  ComponentPropsWithoutRef<typeof Select.Content>,
  'dangerouslySetInnerHTML'
>;

export const SelectContent = forwardRef<ComponentRef<typeof Select.Content>, SelectContentProps>(
  function SelectContent({ className, children, ...rest }, ref) {
    const classNames = [styles.content, className].filter(Boolean).join(' ');
    return (
      <Select.Portal>
        <Select.Content ref={ref} className={classNames} {...rest}>
          <Select.Viewport className={styles.viewport}>{children}</Select.Viewport>
        </Select.Content>
      </Select.Portal>
    );
  },
);

export type SelectItemProps = Omit<
  ComponentPropsWithoutRef<typeof Select.Item>,
  'dangerouslySetInnerHTML'
>;

export const SelectItem = forwardRef<ComponentRef<typeof Select.Item>, SelectItemProps>(
  function SelectItem({ className, children, ...rest }, ref) {
    const classNames = [styles.item, className].filter(Boolean).join(' ');
    return (
      <Select.Item ref={ref} className={classNames} {...rest}>
        <Select.ItemText>{children}</Select.ItemText>
        <Select.ItemIndicator className={styles.indicator}>✓</Select.ItemIndicator>
      </Select.Item>
    );
  },
);
