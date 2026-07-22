import * as Tooltip from '@radix-ui/react-tooltip';
import { forwardRef } from 'react';

import styles from './Tooltip.module.css';

import type { ComponentPropsWithoutRef, ComponentRef } from 'react';

export const TooltipProvider = Tooltip.Provider;

export const TooltipRoot = Tooltip.Root;

export type TooltipTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof Tooltip.Trigger>,
  'dangerouslySetInnerHTML'
>;

export const TooltipTrigger = forwardRef<ComponentRef<typeof Tooltip.Trigger>, TooltipTriggerProps>(
  function TooltipTrigger({ className, ...rest }, ref) {
    const classNames = [styles.trigger, className].filter(Boolean).join(' ');
    return <Tooltip.Trigger ref={ref} className={classNames} {...rest} />;
  },
);

export type TooltipContentProps = Omit<
  ComponentPropsWithoutRef<typeof Tooltip.Content>,
  'dangerouslySetInnerHTML'
>;

export const TooltipContent = forwardRef<ComponentRef<typeof Tooltip.Content>, TooltipContentProps>(
  function TooltipContent({ className, ...rest }, ref) {
    const classNames = [styles.content, className].filter(Boolean).join(' ');
    return (
      <Tooltip.Portal>
        <Tooltip.Content ref={ref} className={classNames} sideOffset={4} {...rest} />
      </Tooltip.Portal>
    );
  },
);
