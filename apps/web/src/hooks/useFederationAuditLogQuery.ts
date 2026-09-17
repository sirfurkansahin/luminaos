import { useQuery } from '@tanstack/react-query';

import { getFederationAuditLog } from '../lib/apiClient.js';

import type { FederationAuditEvent } from '../lib/apiClient.js';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T14 PR3 (ADR-0048 §h/RBAC özeti "member+") -- mirrors
 * `useFederationLinksQuery.ts`'s exact query-key shape. Query key is
 * `['federation-audit-log', workspaceId, linkId]`. No RBAC gate is enforced
 * client-side here (ADR-0016 §a: read paths are never role-gated beyond
 * plain membership -- the server's `WorkspaceMembershipGuard` is the only
 * enforcement point).
 */
export function useFederationAuditLogQuery(
  workspaceId: string,
  linkId: string,
): UseQueryResult<{ events: FederationAuditEvent[] }> {
  return useQuery({
    queryKey: ['federation-audit-log', workspaceId, linkId],
    queryFn: () => getFederationAuditLog(workspaceId, linkId),
  });
}
