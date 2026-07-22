import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { forwardRef } from 'react';

import styles from './DropdownMenu.module.css';

import type { ComponentPropsWithoutRef, ComponentRef } from 'react';

export const DropdownMenuRoot = DropdownMenu.Root;

export type DropdownMenuTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenu.Trigger>,
  'dangerouslySetInnerHTML'
>;

export const DropdownMenuTrigger = forwardRef<
  ComponentRef<typeof DropdownMenu.Trigger>,
  DropdownMenuTriggerProps
>(function DropdownMenuTrigger({ className, ...rest }, ref) {
  const classNames = [styles.trigger, className].filter(Boolean).join(' ');
  return <DropdownMenu.Trigger ref={ref} className={classNames} {...rest} />;
});

export type DropdownMenuContentProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>,
  'dangerouslySetInnerHTML'
>;

export const DropdownMenuContent = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent({ className, ...rest }, ref) {
  const classNames = [styles.content, className].filter(Boolean).join(' ');
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content ref={ref} className={classNames} sideOffset={4} {...rest} />
    </DropdownMenu.Portal>
  );
});

type RadixDropdownMenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item>;

// `onSelect` is widened to explicitly accept `| undefined` — see the same note
// on Checkbox's `onCheckedChange` above (`exactOptionalPropertyTypes` vs. a
// caller-supplied optional handler prop). The cast when spreading onto
// `DropdownMenu.Item` bridges back to Radix's own (merely-optional) type.
export type DropdownMenuItemProps = Omit<
  RadixDropdownMenuItemProps,
  'dangerouslySetInnerHTML' | 'onSelect'
> & {
  onSelect?: RadixDropdownMenuItemProps['onSelect'] | undefined;
};

export const DropdownMenuItem = forwardRef<
  ComponentRef<typeof DropdownMenu.Item>,
  DropdownMenuItemProps
>(function DropdownMenuItem({ className, ...rest }, ref) {
  const classNames = [styles.item, className].filter(Boolean).join(' ');
  return (
    <DropdownMenu.Item ref={ref} className={classNames} {...(rest as RadixDropdownMenuItemProps)} />
  );
});
