import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CURATED_ICON_NAMES, IconPicker, resolveIcon } from './IconPicker.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/IconPicker.tsx to satisfy these tests, and add
 * `lucide-react` as a runtime dependency of apps/web/package.json (F1-T9 PR2
 * plan) — neither exists yet, so this import will fail to resolve until
 * then. That's the expected TDD red state.):
 *
 *   export const CURATED_ICON_NAMES: readonly string[];
 *       // the fixed, curated set of selectable icon names pinned below —
 *       // exactly this list, in this order (order is not itself asserted by
 *       // name here, only membership/count, so implementer has some
 *       // latitude on ordering within the trigger/menu).
 *
 *   export function resolveIcon(name: string | undefined): ComponentType<{ size?: number }>;
 *       // looks `name` up against a `lucide-react` icon registry keyed by
 *       // CURATED_ICON_NAMES; an unrecognized or undefined name returns a
 *       // safe fallback icon component — this function must NEVER throw,
 *       // and must never return `undefined` itself (always a renderable
 *       // component).
 *
 *   export interface IconPickerProps {
 *     value: string | undefined;
 *     onChange: (name: string) => void;
 *   }
 *   export function IconPicker(props: IconPickerProps): React.JSX.Element;
 *       // Trigger: `data-testid="icon-picker-trigger"`, `aria-label="İkon
 *       // seç"`. Renders a child `data-testid="icon-picker-selected-icon"`
 *       // carrying `data-icon-name={value}` ONLY when `value` is a member of
 *       // CURATED_ICON_NAMES; when `value` is undefined or unrecognized, that
 *       // attribute is omitted (a `resolveIcon` fallback glyph is still
 *       // rendered underneath, but it does not claim a real selection).
 *       //
 *       // Clicking (or Enter/Space on) the trigger opens
 *       // `role="menu"` (`data-testid="icon-picker-menu"`) containing one
 *       // `role="menuitem"` per CURATED_ICON_NAMES entry
 *       // (`data-testid="icon-picker-option-${name}"`, accessible name ===
 *       // the icon name). Clicking an option calls `onChange(name)` and
 *       // closes the menu.
 */

describe('CURATED_ICON_NAMES', () => {
  it('pins the curated icon set to the expected list of names', () => {
    expect(CURATED_ICON_NAMES).toEqual([
      'List',
      'Kanban',
      'Table',
      'Calendar',
      'GanttChart',
      'Star',
      'Flag',
      'Tag',
      'Folder',
      'FolderOpen',
      'Users',
      'User',
      'CircleCheck',
      'Circle',
      'Clock',
      'Target',
      'Rocket',
      'Zap',
      'Bell',
      'Bookmark',
      'Archive',
      'Inbox',
      'Layers',
      'LayoutGrid',
      'BarChart',
      'PieChart',
      'TrendingUp',
      'Briefcase',
      'FileText',
      'Home',
    ]);
    expect(CURATED_ICON_NAMES.length).toBeGreaterThanOrEqual(24);
    expect(CURATED_ICON_NAMES.length).toBeLessThanOrEqual(40);
  });
});

describe('resolveIcon', () => {
  it('returns a renderable component for a recognized name (renders an <svg>, does not throw)', () => {
    const Icon = resolveIcon('Star');

    const { container } = render(<Icon />);

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('returns a different component identity per distinct recognized name', () => {
    const StarIcon = resolveIcon('Star');
    const ListIcon = resolveIcon('List');

    expect(StarIcon).not.toBe(ListIcon);
  });

  it('returns a safe fallback component (never throws) for an unrecognized name', () => {
    const Icon = resolveIcon('NotARealLucideIconName');

    let container: HTMLElement | undefined;
    expect(() => {
      ({ container } = render(<Icon />));
    }).not.toThrow();
    expect(container?.querySelector('svg')).not.toBeNull();
  });

  it('returns a safe fallback component (never throws) for undefined', () => {
    const Icon = resolveIcon(undefined);

    let container: HTMLElement | undefined;
    expect(() => {
      ({ container } = render(<Icon />));
    }).not.toThrow();
    expect(container?.querySelector('svg')).not.toBeNull();
  });
});

describe('IconPicker', () => {
  it('renders a trigger with an accessible name when no value is selected', () => {
    render(<IconPicker value={undefined} onChange={vi.fn()} />);

    const trigger = screen.getByTestId('icon-picker-trigger');
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByTestId('icon-picker-selected-icon')).not.toBeInTheDocument();
  });

  it('renders the resolved selected icon when value is a recognized curated name', () => {
    render(<IconPicker value="Star" onChange={vi.fn()} />);

    const selected = screen.getByTestId('icon-picker-selected-icon');
    expect(selected).toHaveAttribute('data-icon-name', 'Star');
  });

  it('renders a placeholder (no claimed selection) when value is an unrecognized name', () => {
    render(<IconPicker value="TotallyNotACuratedIcon" onChange={vi.fn()} />);

    expect(screen.queryByTestId('icon-picker-selected-icon')).not.toBeInTheDocument();
    expect(screen.getByTestId('icon-picker-trigger')).toBeInTheDocument();
  });

  it('opens a menu listing every curated icon option when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<IconPicker value={undefined} onChange={vi.fn()} />);

    await user.click(screen.getByTestId('icon-picker-trigger'));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    const options = screen.getAllByRole('menuitem');
    expect(options).toHaveLength(CURATED_ICON_NAMES.length);
    expect(screen.getByTestId('icon-picker-option-List')).toBeInTheDocument();
    expect(screen.getByTestId('icon-picker-option-Kanban')).toBeInTheDocument();
    expect(screen.getByTestId('icon-picker-option-Table')).toBeInTheDocument();
    expect(screen.getByTestId('icon-picker-option-Calendar')).toBeInTheDocument();
    expect(screen.getByTestId('icon-picker-option-Star')).toBeInTheDocument();
  });

  it('clicking an option calls onChange with that icon name and closes the menu', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<IconPicker value={undefined} onChange={onChange} />);

    await user.click(screen.getByTestId('icon-picker-trigger'));
    await screen.findByRole('menu');

    await user.click(screen.getByTestId('icon-picker-option-Star'));

    expect(onChange).toHaveBeenCalledWith('Star');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
