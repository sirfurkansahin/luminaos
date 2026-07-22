import * as Dialog from '@radix-ui/react-dialog';
import { forwardRef } from 'react';

import styles from './Dialog.module.css';

import type { ComponentPropsWithoutRef, ComponentRef } from 'react';

export const DialogRoot = Dialog.Root;

export type DialogTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof Dialog.Trigger>,
  'dangerouslySetInnerHTML'
>;

export const DialogTrigger = forwardRef<ComponentRef<typeof Dialog.Trigger>, DialogTriggerProps>(
  function DialogTrigger({ className, ...rest }, ref) {
    const classNames = [styles.trigger, className].filter(Boolean).join(' ');
    return <Dialog.Trigger ref={ref} className={classNames} {...rest} />;
  },
);

export type DialogContentProps = Omit<
  ComponentPropsWithoutRef<typeof Dialog.Content>,
  'dangerouslySetInnerHTML'
>;

export const DialogContent = forwardRef<ComponentRef<typeof Dialog.Content>, DialogContentProps>(
  function DialogContent({ className, ...rest }, ref) {
    const classNames = [styles.content, className].filter(Boolean).join(' ');
    return (
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content ref={ref} className={classNames} {...rest} />
      </Dialog.Portal>
    );
  },
);

export type DialogTitleProps = Omit<
  ComponentPropsWithoutRef<typeof Dialog.Title>,
  'dangerouslySetInnerHTML'
>;

export const DialogTitle = forwardRef<ComponentRef<typeof Dialog.Title>, DialogTitleProps>(
  function DialogTitle({ className, ...rest }, ref) {
    const classNames = [styles.title, className].filter(Boolean).join(' ');
    return <Dialog.Title ref={ref} className={classNames} {...rest} />;
  },
);

export type DialogDescriptionProps = Omit<
  ComponentPropsWithoutRef<typeof Dialog.Description>,
  'dangerouslySetInnerHTML'
>;

export const DialogDescription = forwardRef<
  ComponentRef<typeof Dialog.Description>,
  DialogDescriptionProps
>(function DialogDescription({ className, ...rest }, ref) {
  const classNames = [styles.description, className].filter(Boolean).join(' ');
  return <Dialog.Description ref={ref} className={classNames} {...rest} />;
});

export type DialogCloseProps = Omit<
  ComponentPropsWithoutRef<typeof Dialog.Close>,
  'dangerouslySetInnerHTML'
>;

export const DialogClose = forwardRef<ComponentRef<typeof Dialog.Close>, DialogCloseProps>(
  function DialogClose({ className, ...rest }, ref) {
    const classNames = [styles.close, className].filter(Boolean).join(' ');
    return <Dialog.Close ref={ref} className={classNames} {...rest} />;
  },
);
