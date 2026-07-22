import { toast } from './toast.js';
import { Button } from '../Button/Button.js';

// `ToastProvider` is mounted once globally by `.ladle/components.tsx`, so
// this story only needs a trigger for the imperative `toast()` API.
export const Default = (): React.JSX.Element => (
  <Button
    onClick={() => {
      toast({ title: 'Saved', description: 'Your changes have been saved.' });
    }}
  >
    Show toast
  </Button>
);
