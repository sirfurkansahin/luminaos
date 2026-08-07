import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvailabilitySelector } from './AvailabilitySelector.js';
import { useAvailabilityQuery, useSetAvailabilityMutation } from '../../hooks/useAvailability.js';

import type { AvailabilitySnapshot } from '../../lib/apiClient.js';

/**
 * F1-T12 PR8b — TDD red step. Contract under test (not yet implemented):
 *
 *   apps/web/src/hooks/useAvailability.ts:
 *     export function useAvailabilityQuery(workspaceId: string): {
 *       data: AvailabilitySnapshot | null | undefined;
 *       isLoading: boolean; isError: boolean; error: Error | null;
 *     }
 *     export function useSetAvailabilityMutation(workspaceId: string): {
 *       mutate: (vars: { status: AvailabilityStatus; until?: string }) => void;
 *       ...
 *     }
 *     (mirrors useObjectsQuery.ts's hook-pair convention — narrow structural
 *     shape only, not the full react-query UseQueryResult/UseMutationResult
 *     unions, per that file's own precedent.)
 *
 *   apps/web/src/views/shared/AvailabilitySelector.tsx:
 *     export interface AvailabilitySelectorProps { workspaceId: string; }
 *     export function AvailabilitySelector(props): JSX.Element
 *
 * Renders a SelectRoot/SelectTrigger (data-testid="availability-select")/
 * SelectContent with three SelectItems (available/focus/ooo, Turkish
 * labels). Shows the CURRENT status as selected (defaults to 'available'
 * display when getAvailability/useAvailabilityQuery returns null, i.e.
 * never set). onValueChange calls the set-availability mutation.
 */

vi.mock('../../hooks/useAvailability.js', () => ({
  useAvailabilityQuery: vi.fn(),
  useSetAvailabilityMutation: vi.fn(),
}));

const mockedUseAvailabilityQuery = vi.mocked(useAvailabilityQuery);
const mockedUseSetAvailabilityMutation = vi.mocked(useSetAvailabilityMutation);

const workspaceId = 'ws-1';

function mockQuery(data: AvailabilitySnapshot | null | undefined) {
  mockedUseAvailabilityQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  });
}

function mockMutation() {
  const mutate = vi.fn();
  mockedUseSetAvailabilityMutation.mockReturnValue({
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  });
  return mutate;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AvailabilitySelector', () => {
  it('renders the current status (e.g. "focus") as the selected trigger value', () => {
    mockQuery({ status: 'focus', updatedAt: '2026-08-05T09:00:00.000Z' });
    mockMutation();

    render(<AvailabilitySelector workspaceId={workspaceId} />);

    expect(screen.getByTestId('availability-select')).toHaveTextContent(/odak/i);
  });

  it('renders "available" (Müsait) as the sensible default when getAvailability returns null (never set)', () => {
    mockQuery(null);
    mockMutation();

    render(<AvailabilitySelector workspaceId={workspaceId} />);

    expect(screen.getByTestId('availability-select')).toHaveTextContent(/müsait/i);
  });

  it('selecting a new option calls the set-availability mutation with the right status', async () => {
    mockQuery({ status: 'available', updatedAt: '2026-08-05T09:00:00.000Z' });
    const mutate = mockMutation();
    const user = userEvent.setup();

    render(<AvailabilitySelector workspaceId={workspaceId} />);

    await user.click(screen.getByTestId('availability-select'));
    await user.click(screen.getByRole('option', { name: /ofis dışı/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ status: 'ooo' }));
  });
});
