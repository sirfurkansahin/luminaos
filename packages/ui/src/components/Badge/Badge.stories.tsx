import { Badge } from './Badge.js';

import type { BadgeVariant } from './Badge.js';

const variants: BadgeVariant[] = ['neutral', 'success', 'warning', 'danger'];

export const Default = (): React.JSX.Element => <Badge>New</Badge>;

export const Variants = (): React.JSX.Element => (
  <div style={{ display: 'flex', gap: '0.5rem' }}>
    {variants.map((variant) => (
      <Badge key={variant} variant={variant}>
        {variant}
      </Badge>
    ))}
  </div>
);
