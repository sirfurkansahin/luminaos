import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationPreferencesPanel as NotificationPreferencesPanelModuleExport } from './NotificationPreferencesPanel.js';

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T13 PR3 (ADR-0047 Karar b/g, spec Kabul Kriterleri) — TDD red step.
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/NotificationPreferencesPanel.tsx to satisfy
 * these tests):
 *
 *   export interface NotificationPreferencesPanelProps {
 *     workspaceId: string;
 *     userId: string;
 *   }
 *   export function NotificationPreferencesPanel(
 *     props: NotificationPreferencesPanelProps,
 *   ): React.JSX.Element;
 *
 * Mirrors `AutonomyTierPanel.tsx`'s top-level loading/error state convention
 * (data-testid="notification-preferences-loading"/"notification-preferences-
 * error") and `BaselineCreationForm.tsx`'s "local controlled `useState` per
 * field + explicit submit button" shape (chosen deliberately over
 * `AutonomyTierPanel`'s/`ReminderPicker`'s "commit on every change" pattern
 * — a budget number AND a two-part quiet-hours window are logically ONE
 * settings-record write, and committing on every keystroke of a number input
 * would fire spurious partial-value mutations, unlike a single per-row
 * `Select`/`Checkbox` value).
 *
 * Uses `useNotificationPreferenceQuery(workspaceId, userId)`
 * (../../hooks/useNotificationPreferenceQuery.js) and
 * `useSetNotificationPreferenceMutation(workspaceId, userId)` (same module)
 * — both mocked via `vi.hoisted`, mirroring `AutonomyTierPanel.test.tsx`'s
 * exact mocking approach; this file never imports that hook module for real.
 * `NotificationPreference`/`QuietHoursWindow` shapes are declared locally,
 * same reasoning as `AutonomyTierPanel.test.tsx`. `./NotificationPreferences
 * Panel.tsx` itself DOES NOT exist yet either — imported directly (
 * `ModuleExport` cast), so this test file is expected to fail to even
 * resolve that import until the component exists — the documented TDD red
 * state.
 *
 * Contract pinned:
 * - top-level states: isLoading (from the query) ->
 *   data-testid="notification-preferences-loading"; isError ->
 *   data-testid="notification-preferences-error".
 * - once loaded, renders a budget number input
 *   (data-testid="notification-preferences-budget-input", HTML
 *   `type="number"`) initialized to
 *   `data.preference?.notificationBudgetPerWindow ?? 0` (0 when the caller
 *   has no stored preference yet — ADR-0047 Karar b fail-open state).
 * - renders a quiet-hours toggle
 *   (data-testid="notification-preferences-quiet-hours-checkbox", a
 *   `@luminaos/ui` `Checkbox`, `aria-checked` reflects state) initialized to
 *   `checked` iff `data.preference?.quietHours !== null &&
 *   data.preference?.quietHours !== undefined`.
 * - renders quiet-hours start/end number inputs
 *   (data-testid="notification-preferences-quiet-hours-start-input"/"-end-
 *   input") initialized to `data.preference?.quietHours?.startHourUtc ?? 0`/
 *   `...endHourUtc ?? 0`; both are `disabled` whenever the quiet-hours
 *   toggle is unchecked, and enabled (not disabled) whenever it is checked.
 * - toggling the quiet-hours checkbox on/off does not itself call the
 *   mutation (local form state only, until Save is clicked).
 * - typing into any of the three number inputs updates its own displayed
 *   value (fully controlled), without calling the mutation.
 * - a Save button (data-testid="notification-preferences-save-button")
 *   calls the mutation's `mutate` with EXACTLY
 *   `{ notificationBudgetPerWindow: <current budget input value as a
 *   number>, quietHours: <null if the quiet-hours checkbox is unchecked,
 *   else { startHourUtc: <current start input value as a number>,
 *   endHourUtc: <current end input value as a number> }> }`.
 * - if the mutation's isError is true, renders data-testid=
 *   "notification-preferences-set-error" without hiding the rest of the
 *   form (budget input stays present/queryable).
 * - every hook is called with exactly `(workspaceId, userId)`.
 */

interface QuietHoursWindow {
  startHourUtc: number;
  endHourUtc: number;
}

interface NotificationPreference {
  id: string;
  workspaceId: string;
  userId: string;
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
  updatedAt: string;
}

interface NotificationPreferenceInput {
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
}

const { mockedUseNotificationPreferenceQuery, mockedUseSetNotificationPreferenceMutation } =
  vi.hoisted(() => {
    return {
      mockedUseNotificationPreferenceQuery: vi.fn(),
      mockedUseSetNotificationPreferenceMutation: vi.fn(),
    };
  });

vi.mock('../../hooks/useNotificationPreferenceQuery.js', () => ({
  useNotificationPreferenceQuery: mockedUseNotificationPreferenceQuery,
  useSetNotificationPreferenceMutation: mockedUseSetNotificationPreferenceMutation,
}));

const NotificationPreferencesPanel = NotificationPreferencesPanelModuleExport;

const workspaceId = 'ws-1';
const userId = 'user-1';

function makePreferenceFixture(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'pref-1',
    workspaceId,
    userId,
    notificationBudgetPerWindow: 10,
    quietHours: { startHourUtc: 22, endHourUtc: 7 },
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockQuery(
  data: { preference: NotificationPreference | null } | undefined,
  overrides: Partial<UseQueryResult<{ preference: NotificationPreference | null }>> = {},
): void {
  mockedUseNotificationPreferenceQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockSetMutation(
  overrides: Partial<
    UseMutationResult<{ preference: NotificationPreference }, Error, NotificationPreferenceInput>
  > = {},
): { setMutate: ReturnType<typeof vi.fn> } {
  const setMutate = vi.fn();
  mockedUseSetNotificationPreferenceMutation.mockReturnValue({
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

describe('NotificationPreferencesPanel', () => {
  it('renders a loading state (data-testid="notification-preferences-loading") while the query is loading', () => {
    mockQuery(undefined, { isLoading: true });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="notification-preferences-error") when the query isError', () => {
    mockQuery(undefined, { isError: true, error: new Error('boom') });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-error')).toBeInTheDocument();
  });

  it('initializes the budget input and quiet-hours fields from a stored preference', () => {
    mockQuery({ preference: makePreferenceFixture() });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-budget-input')).toHaveValue(10);
    expect(screen.getByTestId('notification-preferences-quiet-hours-checkbox')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('notification-preferences-quiet-hours-start-input')).toHaveValue(22);
    expect(screen.getByTestId('notification-preferences-quiet-hours-end-input')).toHaveValue(7);
  });

  it('defaults the budget input to 0 and the quiet-hours checkbox to unchecked when there is no stored preference yet (ADR-0047 Karar b fail-open)', () => {
    mockQuery({ preference: null });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-budget-input')).toHaveValue(0);
    expect(screen.getByTestId('notification-preferences-quiet-hours-checkbox')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('disables the quiet-hours start/end inputs while the quiet-hours checkbox is unchecked', () => {
    mockQuery({ preference: null });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-quiet-hours-start-input')).toBeDisabled();
    expect(screen.getByTestId('notification-preferences-quiet-hours-end-input')).toBeDisabled();
  });

  it('enables the quiet-hours start/end inputs once the quiet-hours checkbox is checked', async () => {
    mockQuery({ preference: null });
    mockSetMutation();
    const user = userEvent.setup();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);
    await user.click(screen.getByTestId('notification-preferences-quiet-hours-checkbox'));

    expect(
      screen.getByTestId('notification-preferences-quiet-hours-start-input'),
    ).not.toBeDisabled();
    expect(screen.getByTestId('notification-preferences-quiet-hours-end-input')).not.toBeDisabled();
  });

  it('updates the budget input display as the user types, without calling the mutation', async () => {
    mockQuery({ preference: makePreferenceFixture({ notificationBudgetPerWindow: 10 }) });
    const { setMutate } = mockSetMutation();
    const user = userEvent.setup();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);
    const budgetInput = screen.getByTestId('notification-preferences-budget-input');
    await user.clear(budgetInput);
    await user.type(budgetInput, '15');

    expect(budgetInput).toHaveValue(15);
    expect(setMutate).not.toHaveBeenCalled();
  });

  it('calls mutate with { notificationBudgetPerWindow, quietHours: null } when Save is clicked with quiet hours unchecked', async () => {
    mockQuery({ preference: null });
    const { setMutate } = mockSetMutation();
    const user = userEvent.setup();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);
    const budgetInput = screen.getByTestId('notification-preferences-budget-input');
    await user.clear(budgetInput);
    await user.type(budgetInput, '20');
    await user.click(screen.getByTestId('notification-preferences-save-button'));

    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({
      notificationBudgetPerWindow: 20,
      quietHours: null,
    });
  });

  it('calls mutate with the edited quiet-hours window when Save is clicked with quiet hours checked', async () => {
    mockQuery({ preference: makePreferenceFixture() });
    const { setMutate } = mockSetMutation();
    const user = userEvent.setup();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);
    const startInput = screen.getByTestId('notification-preferences-quiet-hours-start-input');
    const endInput = screen.getByTestId('notification-preferences-quiet-hours-end-input');
    await user.clear(startInput);
    await user.type(startInput, '23');
    await user.clear(endInput);
    await user.type(endInput, '6');
    await user.click(screen.getByTestId('notification-preferences-save-button'));

    expect(setMutate).toHaveBeenCalledTimes(1);
    expect(setMutate).toHaveBeenCalledWith({
      notificationBudgetPerWindow: 10,
      quietHours: { startHourUtc: 23, endHourUtc: 6 },
    });
  });

  it('sends quietHours: null when Save is clicked after unchecking a previously-checked quiet-hours toggle', async () => {
    mockQuery({ preference: makePreferenceFixture() });
    const { setMutate } = mockSetMutation();
    const user = userEvent.setup();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);
    await user.click(screen.getByTestId('notification-preferences-quiet-hours-checkbox'));
    await user.click(screen.getByTestId('notification-preferences-save-button'));

    expect(setMutate).toHaveBeenCalledWith({
      notificationBudgetPerWindow: 10,
      quietHours: null,
    });
  });

  it('renders a visible set-error message (data-testid="notification-preferences-set-error") without hiding the form when the mutation isError', () => {
    mockQuery({ preference: null });
    mockSetMutation({ isError: true, error: new Error('Forbidden') });

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.getByTestId('notification-preferences-set-error')).toBeInTheDocument();
    expect(screen.getByTestId('notification-preferences-budget-input')).toBeInTheDocument();
  });

  it('does not render the set-error message when the mutation is not in an error state', () => {
    mockQuery({ preference: null });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(screen.queryByTestId('notification-preferences-set-error')).not.toBeInTheDocument();
  });

  it('sources identity only from the workspaceId/userId props -- every hook is called with exactly (workspaceId, userId)', () => {
    mockQuery({ preference: null });
    mockSetMutation();

    render(<NotificationPreferencesPanel workspaceId={workspaceId} userId={userId} />);

    expect(mockedUseNotificationPreferenceQuery).toHaveBeenCalledWith(workspaceId, userId);
    expect(mockedUseSetNotificationPreferenceMutation).toHaveBeenCalledWith(workspaceId, userId);
  });
});
