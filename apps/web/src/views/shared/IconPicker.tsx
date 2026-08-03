import {
  Archive,
  BarChart,
  Bell,
  Bookmark,
  Briefcase,
  Calendar,
  Circle,
  CircleCheck,
  Clock,
  FileText,
  Flag,
  Folder,
  FolderOpen,
  GanttChart,
  HelpCircle,
  Home,
  Inbox,
  Kanban,
  Layers,
  LayoutGrid,
  List,
  PieChart,
  Rocket,
  Star,
  Table,
  Tag,
  Target,
  TrendingUp,
  User,
  Users,
  Zap,
} from 'lucide-react';
import { createElement } from 'react';

import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from '@luminaos/ui';

import type { LucideProps } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * The fixed, curated set of selectable icon names (F1-T9 PR2 plan — a
 * curated ~24-40 icon set rather than exposing all ~1500 lucide-react icon
 * names). Order here also drives menu-render order.
 */
export const CURATED_ICON_NAMES = [
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
] as const;

type CuratedIconName = (typeof CURATED_ICON_NAMES)[number];

// `LucideProps` alone doesn't type arbitrary `data-*` attributes (they're
// only special-cased by TypeScript's JSX checker for intrinsic host
// elements, not for a `ComponentType` reference like this one) — widened
// here since IconPicker's selected-icon render site needs to pass
// `data-testid`/`data-icon-name` through to the underlying `<svg>`, which
// every lucide-react icon already forwards via its own `...rest` spread.
type IconComponent = ComponentType<LucideProps & Record<`data-${string}`, string | undefined>>;

const ICON_REGISTRY: Record<CuratedIconName, IconComponent> = {
  List,
  Kanban,
  Table,
  Calendar,
  GanttChart,
  Star,
  Flag,
  Tag,
  Folder,
  FolderOpen,
  Users,
  User,
  CircleCheck,
  Circle,
  Clock,
  Target,
  Rocket,
  Zap,
  Bell,
  Bookmark,
  Archive,
  Inbox,
  Layers,
  LayoutGrid,
  BarChart,
  PieChart,
  TrendingUp,
  Briefcase,
  FileText,
  Home,
};

function isCuratedIconName(name: string | undefined): name is CuratedIconName {
  return name !== undefined && (CURATED_ICON_NAMES as readonly string[]).includes(name);
}

/**
 * Looks `name` up against the curated icon registry; an unrecognized or
 * undefined name returns a safe fallback icon component instead — this
 * function never throws and never returns `undefined`.
 */
export function resolveIcon(name: string | undefined): IconComponent {
  if (isCuratedIconName(name)) {
    return ICON_REGISTRY[name];
  }
  return HelpCircle;
}

export interface IconPickerProps {
  value: string | undefined;
  onChange: (name: string) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const isRecognized = isCuratedIconName(value);

  // Rendered via `createElement` rather than a JSX tag (`<SelectedIcon .../>`)
  // deliberately — `resolveIcon`/`ICON_REGISTRY` always return an existing,
  // stable icon component reference (never a freshly-created one per
  // render), but the `react-hooks/static-components` lint rule can't tell a
  // registry lookup apart from a component genuinely defined inline; a plain
  // function call sidesteps that false positive without disabling the rule.
  const selectedIconElement = isRecognized
    ? createElement(resolveIcon(value), {
        'data-testid': 'icon-picker-selected-icon',
        'data-icon-name': value,
      })
    : createElement(resolveIcon(value));

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger data-testid="icon-picker-trigger" aria-label="İkon seç">
        {selectedIconElement}
      </DropdownMenuTrigger>
      <DropdownMenuContent data-testid="icon-picker-menu" role="menu">
        {CURATED_ICON_NAMES.map((name) => (
          <DropdownMenuItem
            key={name}
            role="menuitem"
            aria-label={name}
            data-testid={`icon-picker-option-${name}`}
            onSelect={() => {
              onChange(name);
            }}
          >
            {createElement(ICON_REGISTRY[name], { size: 16 })}
            <span>{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
