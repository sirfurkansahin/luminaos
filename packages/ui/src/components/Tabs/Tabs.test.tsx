import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TabsRoot, TabsList, TabsTrigger, TabsContent } from './Tabs.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * packages/ui/src/components/Tabs/Tabs.tsx + Tabs.module.css to satisfy these
 * tests, and add `@radix-ui/react-tabs` as a dependency):
 *
 *   export const TabsRoot = forwardRef<HTMLDivElement, TabsRootProps>(...);       // wraps Tabs.Root
 *   export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(...);       // wraps Tabs.List
 *   export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(...); // wraps Tabs.Trigger
 *   export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(...); // wraps Tabs.Content
 *
 * Props extend `Omit<ComponentPropsWithoutRef<typeof Tabs.X>,
 * 'dangerouslySetInnerHTML'>` (security-reviewer requirement from PR-A).
 *
 * Behavior under test (Radix-owned, default automatic activation):
 * - `TabsList` renders with `role="tablist"`; children render with `role="tab"`.
 * - Only the `role="tabpanel"` matching the active tab's value is present.
 * - `ArrowRight`/`ArrowLeft` move focus AND the active tab selection between
 *   tabs (Radix's default `activationMode="automatic"`).
 */

function TestTabs() {
  return (
    <TabsRoot defaultValue="tab1">
      <TabsList aria-label="Test tabs">
        <TabsTrigger value="tab1">Tab One</TabsTrigger>
        <TabsTrigger value="tab2">Tab Two</TabsTrigger>
        <TabsTrigger value="tab3">Tab Three</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1">Content one</TabsContent>
      <TabsContent value="tab2">Content two</TabsContent>
      <TabsContent value="tab3">Content three</TabsContent>
    </TabsRoot>
  );
}

describe('Tabs', () => {
  it('renders a tablist with tab children', () => {
    render(<TestTabs />);

    expect(screen.getByRole('tablist', { name: 'Test tabs' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('shows the tabpanel content for the initially active tab only', () => {
    render(<TestTabs />);

    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content one');
    expect(screen.queryByText('Content two')).not.toBeInTheDocument();
    expect(screen.queryByText('Content three')).not.toBeInTheDocument();
  });

  it('ArrowRight moves focus and active selection to the next tab', async () => {
    const user = userEvent.setup();
    render(<TestTabs />);

    screen.getByRole('tab', { name: 'Tab One' }).focus();
    await user.keyboard('{ArrowRight}');

    const tabTwo = screen.getByRole('tab', { name: 'Tab Two' });
    expect(tabTwo).toHaveFocus();
    expect(tabTwo).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content two');
  });

  it('ArrowLeft moves focus and active selection back to the previous tab', async () => {
    const user = userEvent.setup();
    render(<TestTabs />);

    screen.getByRole('tab', { name: 'Tab One' }).focus();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Tab Three' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');

    const tabTwo = screen.getByRole('tab', { name: 'Tab Two' });
    expect(tabTwo).toHaveFocus();
    expect(tabTwo).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content two');
  });
});
