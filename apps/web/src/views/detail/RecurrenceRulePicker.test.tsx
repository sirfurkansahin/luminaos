import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecurrenceRule } from '@luminaos/core-objects';

import { RecurrenceRulePicker } from './RecurrenceRulePicker.js';
import { useRecurrenceRuleMutations } from '../../hooks/useRecurrenceRuleMutations.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/detail/RecurrenceRulePicker.tsx to satisfy these
 * tests. That's the expected TDD red state — this file fails to even
 * resolve its own `./RecurrenceRulePicker.js` import (nor
 * `../../hooks/useRecurrenceRuleMutations.js`, pinned separately by
 * useRecurrenceRuleMutations.test.ts) until both exist.
 *
 *   export interface RecurrenceRulePickerProps {
 *     workspaceId: string;
 *     objectId: string;
 *     currentRule: RecurrenceRule | undefined;
 *   }
 *   export function RecurrenceRulePicker(props: RecurrenceRulePickerProps): React.JSX.Element;
 *
 * Internally calls `useRecurrenceRuleMutations(workspaceId, objectId)`
 * (../../hooks/useRecurrenceRuleMutations.js, mocked wholesale below — this
 * file only proves RecurrenceRulePicker wires `setRule.mutate`/
 * `clearRule.mutate` correctly, not the hook's real optimistic/rollback
 * internals, which are separately pinned by
 * useRecurrenceRuleMutations.test.ts. Mirrors ChecklistWidget.test.tsx's
 * "mock the mutation hook wholesale" style).
 *
 * Built on `@luminaos/ui`'s real (non-mocked) `SelectRoot`/`SelectTrigger`/
 * `SelectValue`/`SelectContent`/`SelectItem` for `frequency` (three options:
 * value `daily` label "Günlük", value `weekly` label "Haftalık", value
 * `monthly` label "Aylık"; `SelectTrigger`'s `aria-label` is "Yineleme
 * sıklığı"), `@luminaos/ui`'s `Input` (`type="number"`,
 * data-testid="recurrence-interval-input", `aria-label`="Aralık") for
 * `interval`, `@luminaos/ui`'s `DateTimePicker` (`mode="date"`,
 * data-testid="recurrence-end-date-input", `aria-label`="Bitiş tarihi") for
 * the optional `endDate`, and a submit `@luminaos/ui` `Button`
 * (data-testid="recurrence-submit-button", accessible name "Kaydet").
 *
 * BYWEEKDAY UI — seven toggleable `@luminaos/ui` `Checkbox`es
 * (data-testid=`recurrence-weekday-<n>` for `n` in `0..6`, ISO-style
 * Monday-first numbering: 0=Pazartesi, 1=Salı, 2=Çarşamba, 3=Perşembe,
 * 4=Cuma, 5=Cumartesi, 6=Pazar), rendered ONLY when the currently-selected
 * frequency is `weekly` — absent from the DOM entirely (not merely
 * disabled/hidden) for `daily`/`monthly`. Checking one toggles that day's
 * membership in the `byWeekday` array submitted on save.
 *
 * PREFILLING — when `currentRule` is provided, the frequency select shows
 * that rule's frequency (trigger displays its label), the interval input's
 * value is `currentRule.interval`, the byWeekday checkboxes (if frequency is
 * `weekly`) reflect `currentRule.byWeekday`, and the end-date input's value
 * is `currentRule.endDate` (verbatim, no format conversion — `endDate` is
 * already `YYYY-MM-DD`, natively compatible with `<input type="date">`).
 * When `currentRule` is `undefined`, all fields start empty/unset (frequency
 * select shows no selected label, interval/end-date inputs are empty).
 *
 * SUBMIT — clicking the submit button calls `setRule.mutate(...)` with a
 * `RecurrenceRule`-shaped object built from the current form state:
 * `{ frequency, interval }` always present; `byWeekday` included ONLY when
 * frequency is `weekly` AND at least one day is checked (an array of the
 * checked days' numeric indices, ascending); `endDate` included ONLY when
 * the end-date input has a non-empty value. Keys that don't apply are
 * OMITTED from the object entirely (mirrors
 * packages/core-objects/src/recurrence-rule-commands.ts's own
 * `setRecurrenceRule`, which only writes `byWeekday`/`endDate` into its
 * event payload `if (input.byWeekday !== undefined)` /
 * `if (input.endDate !== undefined)`).
 *
 * INTERVAL VALIDATION — DESIGN DECISION (documented per task brief, final
 * call made by test-writer after reading existing repo patterns): a
 * client-side guard mirroring `recurrence-rule-commands.ts`'s own domain
 * rule (`interval` must be an integer >= 1) SILENTLY no-ops the submit (no
 * `setRule.mutate` call, no inline error message) when the interval field is
 * empty or resolves to a non-positive/non-integer number — exactly the same
 * "silent no-op guard, no inline error UI" convention
 * ChecklistWidget.tsx/ChecklistWidget.test.tsx already established for its
 * own domain guard (submitting an empty/whitespace-only checklist item draft
 * is a no-op). This keeps the client-side guard family consistent across
 * this widget group rather than introducing a new, one-off inline-error
 * pattern (and a new user-facing string) for this single field. A richer
 * inline-error affordance is a reasonable follow-up but out of THIS PR's
 * scope per the plan's own text.
 *
 * CLEAR — a clear `@luminaos/ui` `Button` (data-testid="recurrence-clear-
 * button", accessible name "Yinelemeyi kaldır") is rendered ONLY when
 * `currentRule !== undefined` (absent from the DOM entirely otherwise) —
 * mirroring `clearRecurrenceRule`'s own domain guard in
 * recurrence-rule-commands.ts, which throws a `ValidationError` ("no
 * recurrenceRule to clear") when `state.recurrenceRule === undefined`; the
 * UI's clear affordance simply never offers an action the domain would
 * reject. Clicking it calls `clearRule.mutate()` (no arguments).
 */

interface MutateCall {
  mutate: ReturnType<typeof vi.fn>;
}

function makeMutation(): MutateCall {
  return { mutate: vi.fn() };
}

vi.mock('../../hooks/useRecurrenceRuleMutations.js', () => ({
  useRecurrenceRuleMutations: vi.fn(),
}));

const mockedUseRecurrenceRuleMutations = vi.mocked(useRecurrenceRuleMutations);

function mockMutations(): {
  setRule: ReturnType<typeof vi.fn>;
  clearRule: ReturnType<typeof vi.fn>;
} {
  const setRule = makeMutation();
  const clearRule = makeMutation();

  // Cast through `unknown` — the real hook's return type is a full
  // `UseMutationResult` per mutation (per useRecurrenceRuleMutations.test.ts's
  // own contract comment); this test only needs the `mutate` function each
  // exposes, mirroring ChecklistWidget.test.tsx's `mockMutations()` helper.
  mockedUseRecurrenceRuleMutations.mockReturnValue({ setRule, clearRule });

  return { setRule: setRule.mutate, clearRule: clearRule.mutate };
}

const workspaceId = 'ws-1';
const objectId = 'obj-1';

async function selectFrequency(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Yineleme sıklığı' }));
  await user.click(await screen.findByRole('option', { name: label }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RecurrenceRulePicker', () => {
  it("renders the current rule's values when currentRule is provided", () => {
    mockMutations();
    const currentRule: RecurrenceRule = {
      frequency: 'weekly',
      interval: 2,
      byWeekday: [1, 3],
      endDate: '2026-12-31',
    };

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={currentRule}
      />,
    );

    const frequencyTrigger = screen.getByRole('combobox', { name: 'Yineleme sıklığı' });
    expect(frequencyTrigger).toHaveTextContent('Haftalık');
    expect(screen.getByTestId('recurrence-interval-input')).toHaveValue(2);
    expect(screen.getByTestId('recurrence-weekday-1')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('recurrence-weekday-3')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('recurrence-weekday-0')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('recurrence-end-date-input')).toHaveValue('2026-12-31');
  });

  it('does not render byWeekday day toggles when the current/selected frequency is daily', () => {
    mockMutations();
    const currentRule: RecurrenceRule = { frequency: 'daily', interval: 1 };

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={currentRule}
      />,
    );

    expect(screen.queryByTestId('recurrence-weekday-0')).not.toBeInTheDocument();
  });

  it('does not render byWeekday day toggles when the current/selected frequency is monthly', () => {
    mockMutations();
    const currentRule: RecurrenceRule = { frequency: 'monthly', interval: 1 };

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={currentRule}
      />,
    );

    expect(screen.queryByTestId('recurrence-weekday-0')).not.toBeInTheDocument();
  });

  it('renders all seven byWeekday day toggles when the current/selected frequency is weekly', () => {
    mockMutations();
    const currentRule: RecurrenceRule = { frequency: 'weekly', interval: 1 };

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={currentRule}
      />,
    );

    for (let day = 0; day <= 6; day += 1) {
      expect(screen.getByTestId(`recurrence-weekday-${day.toString()}`)).toBeInTheDocument();
    }
  });

  it('calls setRule.mutate({ frequency: "daily", interval }) with no byWeekday/endDate keys for a daily rule', async () => {
    const { setRule } = mockMutations();
    const user = userEvent.setup();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    await selectFrequency('Günlük');
    await user.clear(screen.getByTestId('recurrence-interval-input'));
    await user.type(screen.getByTestId('recurrence-interval-input'), '3');
    await user.click(screen.getByTestId('recurrence-submit-button'));

    expect(setRule).toHaveBeenCalledWith({ frequency: 'daily', interval: 3 });
  });

  it('calls setRule.mutate with byWeekday for a weekly rule with days toggled on', async () => {
    const { setRule } = mockMutations();
    const user = userEvent.setup();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    await selectFrequency('Haftalık');
    await user.clear(screen.getByTestId('recurrence-interval-input'));
    await user.type(screen.getByTestId('recurrence-interval-input'), '1');
    await user.click(screen.getByTestId('recurrence-weekday-1'));
    await user.click(screen.getByTestId('recurrence-weekday-3'));
    await user.click(screen.getByTestId('recurrence-submit-button'));

    expect(setRule).toHaveBeenCalledWith({ frequency: 'weekly', interval: 1, byWeekday: [1, 3] });
  });

  it('calls setRule.mutate with an endDate key when the end-date field is filled in', async () => {
    const { setRule } = mockMutations();
    const user = userEvent.setup();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    await selectFrequency('Günlük');
    await user.clear(screen.getByTestId('recurrence-interval-input'));
    await user.type(screen.getByTestId('recurrence-interval-input'), '1');
    const endDateInput = screen.getByTestId('recurrence-end-date-input');
    (endDateInput as HTMLInputElement).focus();
    await user.paste('2026-12-31');
    await user.click(screen.getByTestId('recurrence-submit-button'));

    expect(setRule).toHaveBeenCalledWith({
      frequency: 'daily',
      interval: 1,
      endDate: '2026-12-31',
    });
  });

  it('does not call setRule.mutate when interval is 0 (invalid, silent no-op guard)', async () => {
    const { setRule } = mockMutations();
    const user = userEvent.setup();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    await selectFrequency('Günlük');
    await user.clear(screen.getByTestId('recurrence-interval-input'));
    await user.type(screen.getByTestId('recurrence-interval-input'), '0');
    await user.click(screen.getByTestId('recurrence-submit-button'));

    expect(setRule).not.toHaveBeenCalled();
  });

  it('does not call setRule.mutate when interval is empty (invalid, silent no-op guard)', async () => {
    const { setRule } = mockMutations();
    const user = userEvent.setup();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    await selectFrequency('Günlük');
    await user.clear(screen.getByTestId('recurrence-interval-input'));
    await user.click(screen.getByTestId('recurrence-submit-button'));

    expect(setRule).not.toHaveBeenCalled();
  });

  it('calls clearRule.mutate() when the clear button is clicked and currentRule is defined', async () => {
    const { clearRule } = mockMutations();
    const user = userEvent.setup();
    const currentRule: RecurrenceRule = { frequency: 'daily', interval: 1 };

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={currentRule}
      />,
    );

    await user.click(screen.getByTestId('recurrence-clear-button'));

    expect(clearRule).toHaveBeenCalledTimes(1);
  });

  it('does not render a clear affordance when currentRule is undefined', () => {
    mockMutations();

    render(
      <RecurrenceRulePicker
        workspaceId={workspaceId}
        objectId={objectId}
        currentRule={undefined}
      />,
    );

    expect(screen.queryByTestId('recurrence-clear-button')).not.toBeInTheDocument();
  });
});
