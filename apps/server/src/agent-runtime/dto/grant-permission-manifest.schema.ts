import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/agent-runtime/permission-
 * manifests` request body (ADR-0035 Karar c/j).
 *
 * This DTO only SHAPE-checks (non-empty strings, ISO-8601 datetime strings
 * for the time window) — the real business-rule validation (non-empty
 * `actionTypes`/`objectTypes`, `startsAt < expiresAt`) is enforced by the
 * domain layer's `assertValidManifestGrant` (`@luminaos/agent-runtime`), the
 * single source of truth for it (same DTO-vs-domain split as
 * `create-trigger.schema.ts`'s own reasoning).
 */
export const grantPermissionManifestSchema = z
  .object({
    agentIdentifier: z.string().min(1).max(100),
    dataScope: z
      .object({
        objectTypes: z.union([z.array(z.string().min(1)), z.literal('all')]),
      })
      .strict(),
    actionTypes: z.array(z.string().min(1)),
    timeWindow: z
      .object({
        startsAt: z.iso.datetime().nullable(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();

export type GrantPermissionManifestInput = z.infer<typeof grantPermissionManifestSchema>;
