import { z } from 'zod';

/**
 * The three `MemoryRecord` event payload schemas, per ADR-0022 Karar (c)/(e)
 * (`docs/adr/ADR-0022-memory-passport.md`).
 *
 * All three are `.strict()` (unknown/extra keys rejected — mass-assignment
 * protection), matching `packages/shared/src/events/domain-event.ts`'s
 * `actorSchema`/`domainEventSchema` convention. The schema is exported
 * directly (no `parseXPayload()` wrapper) — callers call `.safeParse()`/
 * `.parse()` themselves, matching this package's sibling schemas.
 *
 * `id`/`kaynakOlayId`/`workspaceId`/`userId`/`occurredAt` all come from the
 * surrounding `DomainEvent` envelope, not the payload — see ADR-0022 Karar
 * (c).
 */
export const memoryRecordAddedPayloadSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict();

/**
 * `MemoryRecordEdited` fully replaces `content` — no field-based patch shape
 * (`{field, oldValue, newValue}`), per ADR-0022 Karar (e).
 */
export const memoryRecordEditedPayloadSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict();

/**
 * `MemoryRecordDeleted`'s payload is empty — the tombstone is expressed by
 * the event's `type` alone, no additional field is needed, per ADR-0022
 * Karar (c).
 */
export const memoryRecordDeletedPayloadSchema = z.object({}).strict();

export type MemoryRecordAddedPayload = z.infer<typeof memoryRecordAddedPayloadSchema>;
export type MemoryRecordEditedPayload = z.infer<typeof memoryRecordEditedPayloadSchema>;
export type MemoryRecordDeletedPayload = z.infer<typeof memoryRecordDeletedPayloadSchema>;
