import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTION_REGISTRY } from '@luminaos/agent-runtime';

import { AutonomyTierPanel as AutonomyTierPanelModuleExport } from './AutonomyTierPanel.js';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T5 PR3 (otonomi kadranı, spec Kabul Kriterleri) — TDD red step. Contract
 * under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/AutonomyTierPanel.tsx to satisfy these tests):
 *
 *   export interface AutonomyTierPanelProps { workspaceId: string; }
 *   export function AutonomyTierPanel(props: AutonomyTierPanelProps): React.JSX.Element;
 *
 * Mirrors `TriggerSuggestionsPanel.tsx`'s top-level loading/error state
 * convention and `McpAccessPanel.tsx`'s real (non-mocked-at-the-DOM-level)
 * `SelectRoot`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`
 * per-row dropdown pattern from `@luminaos/ui`.
 *
 * Contract pinned:
 * - top-level states: isLoading (from the query) ->
 *   data-testid="autonomy-tier-settings-loading"; isError ->
 *   data-testid="autonomy-tier-settings-error".
 * - once loaded, renders EXACTLY 6 rows, one per KNOWN action type
 *   (`createTask`, `generateSubtasks`, `assignPeople`,
 *   `createTaskFromMeeting`, `createTaskFromTrigger`,
 *   `reconfigureAgentPermissions`), each data-testid=
 *   `autonomy-tier-item-${actionType}` — REGARDLESS of what the query's
 *   `settings` array contains.
 * - each row's selected tier reflects
 *   `settings.find(s => s.actionType === thisType)?.tier ?? 'propose'`.
 * - each row has a tier select control (SelectRoot/SelectTrigger/
 *   SelectContent/SelectItem) with data-testid=
 *   `autonomy-tier-select-${actionType}` on the SelectTrigger.
 * - changing a row's select value calls the mutation's `mutate` with EXACTLY
 *   `{ actionType: <that row's actionType>, tier: <newly selected tier> }`.
 * - the `reconfigureAgentPermissions` row's select control is `disabled`,
 *   regardless of whether the query has a stored row for it.
 * - if the mutation's isError is true, renders data-testid=
 *   "autonomy-tier-set-error" without hiding the rest of the panel.
 * - every hook is called with exactly `workspaceId`.
 *
 * ADDITIONAL testability pin (not spelled out verbatim in the plan, but
 * required to deterministically drive/verify a Radix `Select` from a test
 * without hardcoding the implementer's — deliberately unpinned — Turkish
 * tier labels, mirroring this codebase's general "data-testid on every
 * interactive/verifiable node" convention): each `SelectItem` inside a row's
 * `SelectContent` MUST carry
 * data-testid=`autonomy-tier-option-${actionType}-${tier}`. Tests use this,
 * plus Radix's own `data-state="checked"` attribute on the currently-selected
 * `SelectItem` (present once its `SelectContent` is opened), to assert which
 * tier is selected and to click a specific option — never by matching
 * user-visible label text.
 *
 * `useAutonomyTierSettingsQuery`/`useSetAutonomyTierMutation`
 * (../../hooks/useAutonomyTierSettingsQuery.ts) do not exist yet, so —
 * mirroring `TriggerSuggestionsPanel.test.tsx`'s handling of the equally
 * not-yet-existing `useTriggerSuggestionsQuery`/etc. — mock functions are
 * created via `vi.hoisted` and referenced ONLY by closure inside the
 * `vi.mock` factory below; this file never imports that hook module itself.
 * The `AutonomyTier`/`TaskAutonomySetting` shapes are declared locally for
 * the same reason. `./AutonomyTierPanel.tsx` itself DOES NOT exist yet
 * either — imported directly (`ModuleExport` cast), so this test file is
 * expected to fail to even resolve that import until the component exists —
 * the documented TDD red state.
 */

type AutonomyTier = 'propose' | 'approve_and_act' | 'act_and_notify';

interface TaskAutonomySetting {
  id: string;
  workspaceId: string;
  actionType: string;
  tier: AutonomyTier;
  updatedBy: { type: 'user' | 'agent' | 'system'; id: string };
  updatedAt: string;
}

const KNOWN_ACTION_TYPES = [
  'createTask',
  'generateSubtasks',
  'assignPeople',
  'createTaskFromMeeting',
  'createTaskFromTrigger',
  'reconfigureAgentPermissions',
] as const;

const { mockedUseAutonomyTierSettingsQuery, mockedUseSetAutonomyTierMutation } = vi.hoisted(() => {
  return {
    mockedUseAutonomyTierSettingsQuery: vi.fn(),
    mockedUseSetAutonomyTierMutation: vi.fn(),
  };
});

vi.mock('../../hooks/useAutonomyTierSettingsQuery.js', () => ({
  useAutonomyTierSettingsQuery: mockedUseAutonomyTierSettingsQuery,
  useSetAutonomyTierMutation: mockedUseSetAutonomyTierMutation,
}));

const AutonomyTierPanel = AutonomyTierPanelModuleExport;

const workspaceId = 'ws-1';

function makeSettingFixture(overrides: Partial<TaskAutonomySetting> = {}): TaskAutonomySetting {
  return {
    id: 'setting-1',
    workspaceId,
    actionType: 'createTask',
    tier: 'approve_and_act',
    updatedBy: { type: 'user', id: 'user-1' },
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockQuery(
  data: { settings: TaskAutonomySetting[] } | undefined,
  overrides: Partial<UseQueryResult<{ settings: TaskAutonomySetting[] }>> = {},
): void {
  mockedUseAutonomyTierSettingsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockSetMutation(
  overrides: Partial<
    UseMutationResult<
      { setting: TaskAutonomySetting },
      Error,
      { actionType: string; tier: AutonomyTier }
    >
  > = {},
): { setMutate: ReturnType<typeof vi.fn> } {
  const setMutate = vi.fn();
  mockedUseSetAutonomyTierMutation.mockReturnValue({
    mutate: setMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
    ...overrides,
  });
  return { setMutate };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AutonomyTierPanel', () => {
  it('renders a loading state (data-testid="autonomy-tier-settings-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('autonomy-tier-settings-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="autonomy-tier-settings-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('autonomy-tier-settings-error')).toBeInTheDocument();
  });

  it('renders exactly 6 rows, one per known action type, even when the query only has stored settings for 2 of them', () => {
    mockQuery({
      settings: [
        makeSettingFixture({ id: 's-1', actionType: 'createTask', tier: 'approve_and_act' }),
        makeSettingFixture({ id: 's-2', actionType: 'generateSubtasks', tier: 'act_and_notify' }),
      ],
    });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    for (const actionType of KNOWN_ACTION_TYPES) {
      expect(screen.getByTestId(`autonomy-tier-item-${actionType}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId(/^autonomy-tier-item-/)).toHaveLength(6);
  });

  it("shows a row's stored tier as selected when the query has an explicit setting for it (createTask -> approve_and_act)", async () => {
    mockQuery({
      settings: [
        makeSettingFixture({ id: 's-1', actionType: 'createTask', tier: 'approve_and_act' }),
      ],
    });
    mockSetMutation();
    const user = userEvent.setup();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('autonomy-tier-select-createTask'));

    expect(screen.getByTestId('autonomy-tier-option-createTask-approve_and_act')).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByTestId('autonomy-tier-option-createTask-propose')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(screen.getByTestId('autonomy-tier-option-createTask-act_and_notify')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
  });

  it("defaults a row's selected tier to 'propose' when the query has no stored setting for it (assignPeople)", async () => {
    mockQuery({
      settings: [
        makeSettingFixture({ id: 's-1', actionType: 'createTask', tier: 'approve_and_act' }),
      ],
    });
    mockSetMutation();
    const user = userEvent.setup();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('autonomy-tier-select-assignPeople'));

    expect(screen.getByTestId('autonomy-tier-option-assignPeople-propose')).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('every row exposes a tier select trigger with data-testid=`autonomy-tier-select-${actionType}`', () => {
    mockQuery({ settings: [] });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    for (const actionType of KNOWN_ACTION_TYPES) {
      expect(screen.getByTestId(`autonomy-tier-select-${actionType}`)).toBeInTheDocument();
    }
  });

  it("selecting 'act_and_notify' for createTask calls the mutation's mutate with { actionType: 'createTask', tier: 'act_and_notify' }", async () => {
    mockQuery({ settings: [] });
    const { setMutate } = mockSetMutation();
    const user = userEvent.setup();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);
    await user.click(screen.getByTestId('autonomy-tier-select-createTask'));
    await user.click(screen.getByTestId('autonomy-tier-option-createTask-act_and_notify'));

    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({ actionType: 'createTask', tier: 'act_and_notify' });
  });

  it("the reconfigureAgentPermissions row's select is disabled when the query has NO stored row for it (defaulting to propose)", () => {
    mockQuery({
      settings: [
        makeSettingFixture({ id: 's-1', actionType: 'createTask', tier: 'approve_and_act' }),
      ],
    });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('autonomy-tier-select-reconfigureAgentPermissions')).toBeDisabled();
  });

  it("the reconfigureAgentPermissions row's select is ALSO disabled when the query DOES have a stored row for it (disabling is not conditional on presence)", () => {
    mockQuery({
      settings: [
        makeSettingFixture({
          id: 's-1',
          actionType: 'reconfigureAgentPermissions',
          tier: 'propose',
        }),
      ],
    });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('autonomy-tier-select-reconfigureAgentPermissions')).toBeDisabled();
  });

  it('renders a visible set-error message (data-testid="autonomy-tier-set-error") without hiding the rest of the panel when the mutation isError', () => {
    mockQuery({ settings: [] });
    mockSetMutation({ isError: true, error: new Error('Forbidden') });

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getByTestId('autonomy-tier-set-error')).toBeInTheDocument();
    for (const actionType of KNOWN_ACTION_TYPES) {
      expect(screen.getByTestId(`autonomy-tier-item-${actionType}`)).toBeInTheDocument();
    }
  });

  it('does not render the set-error message when the mutation is not in an error state', () => {
    mockQuery({ settings: [] });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.queryByTestId('autonomy-tier-set-error')).not.toBeInTheDocument();
  });

  it('sources identity only from the workspaceId prop -- every hook is called with exactly that value', () => {
    mockQuery({ settings: [] });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(mockedUseAutonomyTierSettingsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUseSetAutonomyTierMutation).toHaveBeenCalledWith(workspaceId);

    for (const mockedHook of [
      mockedUseAutonomyTierSettingsQuery,
      mockedUseSetAutonomyTierMutation,
    ]) {
      for (const call of mockedHook.mock.calls as unknown[][]) {
        expect(call).toEqual([workspaceId]);
      }
    }
  });
});

/**
 * F3-T9 PR2 (ADR-0043 Karar f, spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`
 * Kabul Kriterleri). `KNOWN_ACTION_TYPES` used to be a hand-maintained,
 * 6-entry array with zero structural link to `@luminaos/agent-runtime`'s
 * `ACTION_REGISTRY` (`packages/agent-runtime/src/action-registry.ts`,
 * already merged in PR1). This suite asserts the panel's rendered rows are
 * DERIVED FROM `ACTION_REGISTRY` (single source of truth, PLAN.md §5's
 * "ikilik oluşmaz" principle) rather than just happening to structurally
 * agree with an independently-maintained duplicate list -- `ACTION_REGISTRY`
 * is imported for real (top of file, now that `@luminaos/agent-runtime` is a
 * declared `apps/web` runtime dependency) and iterated to derive the
 * expected assertions, instead of hardcoding a second copy of the 6 entries
 * in this test file.
 */
describe('AutonomyTierPanel <- ACTION_REGISTRY (ADR-0043 Karar f, single source of truth)', () => {
  it('renders exactly one row per @luminaos/agent-runtime ACTION_REGISTRY entry, with matching data-testid and visible label -- not just a coincidentally-identical hardcoded list', () => {
    mockQuery({ settings: [] });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    expect(screen.getAllByTestId(/^autonomy-tier-item-/)).toHaveLength(ACTION_REGISTRY.length);
    for (const entry of ACTION_REGISTRY) {
      const row = screen.getByTestId(`autonomy-tier-item-${entry.actionType}`);
      expect(row).toHaveTextContent(entry.label);
      expect(
        within(row).getByTestId(`autonomy-tier-select-${entry.actionType}`),
      ).toBeInTheDocument();
    }
  });
});

describe('AutonomyTierPanel row scoping', () => {
  it("each row's item container scopes its OWN select trigger only (createTask row does not contain assignPeople's select)", () => {
    mockQuery({ settings: [] });
    mockSetMutation();

    render(<AutonomyTierPanel workspaceId={workspaceId} />);

    const createTaskRow = screen.getByTestId('autonomy-tier-item-createTask');
    expect(
      within(createTaskRow).getByTestId('autonomy-tier-select-createTask'),
    ).toBeInTheDocument();
    expect(
      within(createTaskRow).queryByTestId('autonomy-tier-select-assignPeople'),
    ).not.toBeInTheDocument();
  });
});
