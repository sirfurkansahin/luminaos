import { describe, expect, it } from 'vitest';

import { Badge, Button, Card, Input, Textarea, ThemeProvider, useTheme } from './index.js';

describe('@luminaos/ui public API', () => {
  it('exposes the theme primitives and base components', () => {
    expect(ThemeProvider).toBeDefined();
    expect(useTheme).toBeDefined();
    expect(Button).toBeDefined();
    expect(Input).toBeDefined();
    expect(Textarea).toBeDefined();
    expect(Card).toBeDefined();
    expect(Badge).toBeDefined();
  });
});
