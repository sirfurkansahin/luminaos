import { useMutation } from '@tanstack/react-query';

import { createFederationCredential, revokeFederationCredential } from '../lib/apiClient.js';

import type { CreateFederationCredentialResult } from '../lib/apiClient.js';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048 §d, İNSAN ONAYLI) -- unlike
 * `useFederationLinksQuery.ts`/`useFederationScopeQuery.ts`, there is NO
 * query invalidation here: there is no server-side GET list endpoint for
 * credentials (ADR-0048 §d/spec PR2 controller surface -- `POST
 * .../credentials` and `POST .../credentials/:id/revoke` only), so
 * `FederationLinksPanel` tracks created credentials in local component state,
 * not via a TanStack Query cache.
 */
export function useCreateFederationCredentialMutation(
  workspaceId: string,
  linkId: string,
): UseMutationResult<
  CreateFederationCredentialResult,
  Error,
  { name: string; expiresAtDays?: 30 | 90 | 365 }
> {
  return useMutation({
    mutationFn: (variables: { name: string; expiresAtDays?: 30 | 90 | 365 }) =>
      createFederationCredential(workspaceId, linkId, variables.name, variables.expiresAtDays),
  });
}

export function useRevokeFederationCredentialMutation(
  workspaceId: string,
  linkId: string,
): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) =>
      revokeFederationCredential(workspaceId, linkId, credentialId),
  });
}
