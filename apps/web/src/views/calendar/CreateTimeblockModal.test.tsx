import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateTimeblockModal } from './CreateTimeblockModal.js';
import { createObject, scheduleTimeBlock } from '../../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { ReactNode } from 'react';

/**
 * Mirrors `CreateObjectButton.test.tsx`'s `createWrapper()` pattern: the
 * modal's submit uses `useMutation`/`useQueryClient` (to invalidate the
 * workspace's cached object/calendar queries once the new timeblock exists —
 * otherwise the calendar would keep showing stale data until a manual
 * refresh), which requires a real `QueryClientProvider` ancestor.
 */
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

/**
 * F1-T12 PR8b — TDD red step. Contract under test (not yet implemented —
 * implementer must build apps/web/src/views/calendar/CreateTimeblockModal.tsx):
 *
 *   export interface CreateTimeblockModalProps {
 *     workspaceId: string;
 *     dateISO: string; // e.g. '2026-05-01' — pre-fills a sensible default
 *                       // start/end window (e.g. 09:00-10:00) that day.
 *     onClose: () => void;
 *   }
 *
 * Renders a DialogRoot(open=true)/DialogContent with:
 *   - a title Input, data-testid="timeblock-title-input"
 *   - a start-time input, data-testid="timeblock-start-input"
 *   - an end-time input, data-testid="timeblock-end-input"
 *   - a submit control, data-testid="timeblock-submit-button"
 *   - a cancel/close control, data-testid="timeblock-cancel-button"
 *
 * On submit: calls createObject(workspaceId, { objectType: 'timeblock',
 * title }) THEN scheduleTimeBlock(workspaceId, createdObject.id, { start,
 * end }), in that order (chained, via a single mutationFn). On success,
 * calls onClose(). On EITHER call rejecting, shows an inline error
 * (data-testid="timeblock-modal-error") and does NOT call onClose. The
 * cancel button calls onClose() without calling either API function.
 *
 * Deliberately NOT literal pixel-precise drag-to-create (see
 * docs/specs/F1-E3/F1-T12-takvim.md "Kapsam DIŞI" note) — this click-to-
 * open-modal flow is the accepted substitute.
 */

vi.mock('../../lib/apiClient.js', () => ({
  createObject: vi.fn(),
  scheduleTimeBlock: vi.fn(),
}));

const mockedCreateObject = vi.mocked(createObject);
const mockedScheduleTimeBlock = vi.mocked(scheduleTimeBlock);

const workspaceId = 'ws-1';
const dateISO = '2026-05-01';

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateTimeblockModal', () => {
  it('renders title/start/end inputs pre-filled sensibly from dateISO', () => {
    const { Wrapper } = createWrapper();
    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('timeblock-title-input')).toBeInTheDocument();
    const startInput = screen.getByTestId<HTMLInputElement>('timeblock-start-input');
    const endInput = screen.getByTestId<HTMLInputElement>('timeblock-end-input');
    expect(startInput.value).toContain(dateISO);
    expect(endInput.value).toContain(dateISO);
  });

  it('submitting calls createObject then scheduleTimeBlock with the created object id, in that order', async () => {
    mockedCreateObject.mockResolvedValueOnce({
      object: { id: 'tb-1', title: 'Odak' } as unknown as ObjectWithFieldValues,
    });
    mockedScheduleTimeBlock.mockResolvedValueOnce({
      object: { id: 'tb-1', title: 'Odak' } as unknown as ObjectWithFieldValues,
    });
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { Wrapper } = createWrapper();

    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={onClose} />, {
      wrapper: Wrapper,
    });

    await user.type(screen.getByTestId('timeblock-title-input'), 'Odak bloğu');
    await user.click(screen.getByTestId('timeblock-submit-button'));

    await waitFor(() => {
      expect(mockedScheduleTimeBlock).toHaveBeenCalled();
    });

    expect(mockedCreateObject).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ objectType: 'timeblock' }),
    );
    expect(mockedScheduleTimeBlock).toHaveBeenCalledWith(
      workspaceId,
      'tb-1',
      expect.objectContaining({
        start: expect.any(String) as string,
        end: expect.any(String) as string,
      }),
    );
    const createOrder = mockedCreateObject.mock.invocationCallOrder[0] as number;
    const scheduleOrder = mockedScheduleTimeBlock.mock.invocationCallOrder[0] as number;
    expect(createOrder).toBeLessThan(scheduleOrder);
  });

  it('calls onClose on successful submit', async () => {
    mockedCreateObject.mockResolvedValueOnce({
      object: { id: 'tb-1', title: 'Odak' } as unknown as ObjectWithFieldValues,
    });
    mockedScheduleTimeBlock.mockResolvedValueOnce({
      object: { id: 'tb-1', title: 'Odak' } as unknown as ObjectWithFieldValues,
    });
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { Wrapper } = createWrapper();

    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={onClose} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('timeblock-submit-button'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('a rejected createObject shows an inline error and does not call onClose', async () => {
    mockedCreateObject.mockRejectedValueOnce(new Error('boom'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={onClose} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('timeblock-submit-button'));

    expect(await screen.findByTestId('timeblock-modal-error')).toBeInTheDocument();
    expect(mockedScheduleTimeBlock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a rejected scheduleTimeBlock (after a successful createObject) shows an inline error and does not call onClose', async () => {
    mockedCreateObject.mockResolvedValueOnce({
      object: { id: 'tb-1', title: 'Odak' } as unknown as ObjectWithFieldValues,
    });
    mockedScheduleTimeBlock.mockRejectedValueOnce(new Error('boom'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={onClose} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('timeblock-submit-button'));

    expect(await screen.findByTestId('timeblock-modal-error')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the cancel button calls onClose without calling either API function', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(<CreateTimeblockModal workspaceId={workspaceId} dateISO={dateISO} onClose={onClose} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('timeblock-cancel-button'));

    expect(onClose).toHaveBeenCalled();
    expect(mockedCreateObject).not.toHaveBeenCalled();
    expect(mockedScheduleTimeBlock).not.toHaveBeenCalled();
  });
});
