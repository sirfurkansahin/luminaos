import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateObjectButton } from './CreateObjectButton.js';
import { createObject } from '../../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';
import type { ReactNode } from 'react';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/shared/CreateObjectButton.tsx to satisfy these tests,
 * and add `@tanstack/react-query` as a runtime dependency of
 * apps/web/package.json — it is not there yet, so this import will fail to
 * resolve until then. That's the expected TDD red state.):
 *
 *   export interface CreateObjectButtonProps {
 *     workspaceId: string;
 *     objectType: string;
 *   }
 *   export function CreateObjectButton(props: CreateObjectButtonProps): React.JSX.Element;
 *
 * A "+ Yeni" quick-create button, discoverable via
 * `data-testid="create-object-button"` (exact copy is i18n-owned, not
 * pinned here). On click, calls `createObject(workspaceId, { objectType,
 * title })` (../../lib/apiClient.ts, pinned separately by
 * apps/web/src/lib/apiClient.test.ts — mocked wholesale here) with SOME
 * non-empty default title — this test does not pin the literal string.
 *
 * On success, invalidates the workspace's cached object queries via
 * `useQueryClient().invalidateQueries(...)` with a filter whose `queryKey`
 * is (or starts with) `['objects', workspaceId, ...]` — the same convention
 * apps/web/src/hooks/useObjectsQuery.ts's `useSetFieldValuesMutation` uses
 * (see apps/web/src/hooks/useObjectsQuery.test.ts) — so any List/Board/Table
 * view watching this workspace's objects refetches. This requires the
 * component tree to be wrapped in a real (non-mocked) `QueryClientProvider`,
 * which these tests provide.
 *
 * On failure (`createObject` rejects), renders an inline error indicator
 * discoverable via `data-testid="create-object-button-error"` (copy is
 * i18n-owned, not pinned; implementer MAY additionally surface a
 * `@luminaos/ui` toast, but that is not exercised by this test file).
 */

vi.mock('../../lib/apiClient.js', () => ({
  createObject: vi.fn(),
}));

const mockedCreateObject = vi.mocked(createObject);

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

const workspaceId = 'ws-1';
const objectType = 'task';

afterEach(() => {
  vi.clearAllMocks();
});

describe('CreateObjectButton', () => {
  it('calls apiClient.createObject with the given workspaceId and objectType when clicked', async () => {
    mockedCreateObject.mockResolvedValueOnce({
      object: { id: 'obj-1', title: 'Untitled' } as unknown as ObjectWithFieldValues,
    });
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(<CreateObjectButton workspaceId={workspaceId} objectType={objectType} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('create-object-button'));

    await waitFor(() => {
      expect(mockedCreateObject).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ objectType, title: expect.any(String) as string }),
      );
    });
  });

  it('invalidates cached ["objects", workspaceId, ...] queries once createObject resolves', async () => {
    mockedCreateObject.mockResolvedValueOnce({
      object: { id: 'obj-1', title: 'Untitled' } as unknown as ObjectWithFieldValues,
    });
    const user = userEvent.setup();
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(<CreateObjectButton workspaceId={workspaceId} objectType={objectType} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('create-object-button'));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });
    const [filters] = invalidateSpy.mock.calls[0] as [{ queryKey?: unknown[] } | undefined];
    expect(filters?.queryKey?.[0]).toBe('objects');
    expect(filters?.queryKey?.[1]).toBe(workspaceId);
  });

  it('renders an inline error indicator (data-testid="create-object-button-error") when apiClient.createObject rejects', async () => {
    mockedCreateObject.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    const { Wrapper } = createWrapper();

    render(<CreateObjectButton workspaceId={workspaceId} objectType={objectType} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByTestId('create-object-button'));

    expect(await screen.findByTestId('create-object-button-error')).toBeInTheDocument();
  });
});
