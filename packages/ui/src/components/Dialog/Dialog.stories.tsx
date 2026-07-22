import {
  DialogRoot,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from './Dialog.js';

export const Default = (): React.JSX.Element => (
  <DialogRoot>
    <DialogTrigger>Open dialog</DialogTrigger>
    <DialogContent>
      <DialogTitle>Dialog title</DialogTitle>
      <DialogDescription>A short description of what this dialog is for.</DialogDescription>
      <DialogClose>Close</DialogClose>
    </DialogContent>
  </DialogRoot>
);
