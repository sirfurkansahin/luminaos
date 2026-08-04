import { useQuery } from '@tanstack/react-query';

import type { FieldDefinition } from '@luminaos/core-objects';

import { getFieldDefinitions } from '../lib/apiClient.js';

import type { FetchStatus } from '@tanstack/react-query';

// A deliberately narrower shape than the full `UseQueryResult<T>` discriminated
// union, mirroring `useObjectsQuery.ts`'s `ObjectQueryResult` pattern (see its
// own comment for the full rationale): `TaskDetailPanel.test.tsx`'s `vi.mock`
// of this hook returns a plain `{ data, isLoading, isError, error }` object
// literal without casting it, so `vi.mocked(useFieldDefinitionsQuery)
// .mockReturnValue(...)`'s inferred parameter type must structurally accept
// exactly that (all four required, non-optional). `isSuccess`/`isPending`/
// `fetchStatus` are ADDITIONALLY declared here, but as optional — this hook's
// OWN test (useFieldDefinitionsQuery.test.ts) exercises the real, non-mocked
// `useQuery` internals via `renderHook` and reads those three fields off
// `result.current` directly, so they must be part of the declared return
// type for that file to typecheck; declaring them optional (rather than
// required) keeps `TaskDetailPanel.test.tsx`'s narrower 4-property mock
// literal valid, since react-query's actual runtime result always has
// strictly more properties than either consumer requires (no cast needed on
// the `return` side below).
export interface FieldDefinitionsQueryResult {
  data: { fieldDefinitions: FieldDefinition[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isSuccess?: boolean;
  isPending?: boolean;
  fetchStatus?: FetchStatus;
}

export function useFieldDefinitionsQuery(
  workspaceId: string,
  objectType: string | undefined,
): FieldDefinitionsQueryResult {
  return useQuery({
    queryKey: ['fieldDefinitions', workspaceId, objectType],
    queryFn: () => getFieldDefinitions(workspaceId, objectType as string),
    enabled: objectType !== undefined,
  });
}
