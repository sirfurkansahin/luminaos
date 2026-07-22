import { Button } from './Button.js';

import type { ButtonSize, ButtonVariant } from './Button.js';

const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];
const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

export const Default = (): React.JSX.Element => <Button>Click me</Button>;

export const Variants = (): React.JSX.Element => (
  <div style={{ display: 'flex', gap: '0.5rem' }}>
    {variants.map((variant) => (
      <Button key={variant} variant={variant}>
        {variant}
      </Button>
    ))}
  </div>
);

export const Sizes = (): React.JSX.Element => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
    {sizes.map((size) => (
      <Button key={size} size={size}>
        {size}
      </Button>
    ))}
  </div>
);

export const Disabled = (): React.JSX.Element => <Button disabled>Click me</Button>;
