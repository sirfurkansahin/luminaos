import { z } from 'zod';

/**
 * Validates `POST /workspaces/:workspaceId/memory` and
 * `PATCH /workspaces/:workspaceId/memory/:id` request bodies. Deliberately
 * NOT `.strict()`, mirroring `grant-desktop-signal-consent.schema.ts`'s exact
 * convention: self-service by construction (ADR-0022 Karar f) means the
 * SESSION user (`req.user.id`) is the only source of user identity — an
 * extra `userId`/`workspaceId` key in the body is a harmless, silently
 * stripped no-op, not a validation error.
 */
export const memoryRecordContentSchema = z.object({
  content: z.string().min(1),
});

export type MemoryRecordContentInput = z.infer<typeof memoryRecordContentSchema>;
