import { z } from 'zod';

/**
 * The two `MemoryAccessPolicy` event payload schemas, per ADR-0024 Karar (g)
 * (`docs/adr/ADR-0024-bellek-kullanim-politikasi.md`).
 *
 * Both are `.strict()` (unknown/extra keys rejected — mass-assignment
 * protection), matching `memory-record-events.ts`'s exact convention.
 *
 * `workspaceId`/`userId`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, not the payload (ADR-0024 §g).
 */
export const memoryAccessGrantedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1),
  })
  .strict();

export const memoryAccessRevokedPayloadSchema = z
  .object({
    agentIdentifier: z.string().min(1),
  })
  .strict();

export type MemoryAccessGrantedPayload = z.infer<typeof memoryAccessGrantedPayloadSchema>;
export type MemoryAccessRevokedPayload = z.infer<typeof memoryAccessRevokedPayloadSchema>;
