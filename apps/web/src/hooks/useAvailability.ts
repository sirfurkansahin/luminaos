import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getAvailability, setAvailability } from '../lib/apiClient.js';

import type { AvailabilitySnapshot, AvailabilityStatus } from '../lib/apiClient.js';
import type { QueryKey } from '@tanstack/react-query';

// A deliberately narrower shape than the full `UseQueryResult<T>`
// discriminated union — mirrors useObjectsQuery.ts's `ObjectQueryResult`
// precedent, since AvailabilitySelector.test.tsx's `vi.mock` of this hook
// returns plain `{ data, isLoading, isError, error }` object literals.
export interface AvailabilityQueryResult {
  data: AvailabilitySnapshot | null | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

function availabilityQueryKey(workspaceId: string): QueryKey {
  return ['availability', workspaceId];
}

export function useAvailabilityQuery(workspaceId: string): AvailabilityQueryResult {
  return useQuery({
    queryKey: availabilityQueryKey(workspaceId),
    queryFn: () => getAvailability(workspaceId),
  });
}

interface SetAvailabilityVariables {
  status: AvailabilityStatus;
  until?: string;
}

// A deliberately narrower shape than the full `UseMutationResult<T>`
// discriminated union — mirrors `AvailabilityQueryResult` above (and
// useObjectsQuery.ts's own precedent), since AvailabilitySelector.test.tsx's
// `vi.mock` of this hook returns a plain object literal with exactly these
// properties, without casting it to the real react-query union type.
export interface AvailabilityMutationResult {
  mutate: (variables: SetAvailabilityVariables) => void;
  mutateAsync: (variables: SetAvailabilityVariables) => Promise<AvailabilitySnapshot>;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: Error | null;
  data: AvailabilitySnapshot | undefined;
  reset: () => void;
  status: 'error' | 'idle' | 'pending' | 'success';
}

export function useSetAvailabilityMutation(workspaceId: string): AvailabilityMutationResult {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ status, until }: SetAvailabilityVariables) =>
      setAvailability(workspaceId, status, until),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: availabilityQueryKey(workspaceId) });
    },
  });
}
