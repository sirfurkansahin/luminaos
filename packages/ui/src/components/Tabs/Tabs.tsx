import * as Tabs from '@radix-ui/react-tabs';
import { forwardRef } from 'react';

import styles from './Tabs.module.css';

import type { ComponentPropsWithoutRef, ComponentRef } from 'react';

export type TabsRootProps = Omit<
  ComponentPropsWithoutRef<typeof Tabs.Root>,
  'dangerouslySetInnerHTML'
>;

export const TabsRoot = forwardRef<ComponentRef<typeof Tabs.Root>, TabsRootProps>(function TabsRoot(
  { className, ...rest },
  ref,
) {
  const classNames = [styles.root, className].filter(Boolean).join(' ');
  return <Tabs.Root ref={ref} className={classNames} {...rest} />;
});

export type TabsListProps = Omit<
  ComponentPropsWithoutRef<typeof Tabs.List>,
  'dangerouslySetInnerHTML'
>;

export const TabsList = forwardRef<ComponentRef<typeof Tabs.List>, TabsListProps>(function TabsList(
  { className, ...rest },
  ref,
) {
  const classNames = [styles.list, className].filter(Boolean).join(' ');
  return <Tabs.List ref={ref} className={classNames} {...rest} />;
});

export type TabsTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof Tabs.Trigger>,
  'dangerouslySetInnerHTML'
>;

export const TabsTrigger = forwardRef<ComponentRef<typeof Tabs.Trigger>, TabsTriggerProps>(
  function TabsTrigger({ className, ...rest }, ref) {
    const classNames = [styles.trigger, className].filter(Boolean).join(' ');
    return <Tabs.Trigger ref={ref} className={classNames} {...rest} />;
  },
);

export type TabsContentProps = Omit<
  ComponentPropsWithoutRef<typeof Tabs.Content>,
  'dangerouslySetInnerHTML'
>;

export const TabsContent = forwardRef<ComponentRef<typeof Tabs.Content>, TabsContentProps>(
  function TabsContent({ className, ...rest }, ref) {
    const classNames = [styles.content, className].filter(Boolean).join(' ');
    return <Tabs.Content ref={ref} className={classNames} {...rest} />;
  },
);
