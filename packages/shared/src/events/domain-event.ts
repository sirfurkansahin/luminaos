import { z } from 'zod';

/**
 * Minimal actor envelope, per F0-T6's plan (`giggly-brewing-moore.md`,
 * "Kararlar"): `{ type, id }` only. CLAUDE.md's richer agent-action contract
 * (`{niyet, gerekçe, kaynaklar[], geri_alma_planı}`) is explicitly deferred to
 * Faz 3 and is not part of this envelope; it will live in `payload` or a
 * separate actor extension later, not here.
 *
 * `.strict()` rejects unknown keys (mass-assignment protection), matching the
 * convention established by `apps/server/src/auth/dto/register.schema.ts`.
 */
export const actorSchema = z
  .object({
    type: z.enum(['user', 'agent', 'system']),
    id: z.string().min(1),
  })
  .strict();

/**
 * The immutable event envelope stored in `events` (see
 * `apps/server/src/db/schema/events.ts`). `version` is the stream-internal
 * optimistic-concurrency position — **not** a payload schema version; payload
 * evolution is handled via `type` naming + read-side upcasters (F1+), never
 * by mutating this envelope.
 *
 * `.strict()` rejects unknown top-level keys, e.g. a caller trying to smuggle
 * a `globalPosition` (storage metadata, not part of the portable envelope —
 * see `apps/server/src/event-store/event-store.service.ts`'s `StoredEvent`)
 * into the domain event itself.
 */
export const domainEventSchema = z
  .object({
    id: z.uuid(),
    streamId: z.uuid(),
    streamType: z.string().min(1).max(100),
    workspaceId: z.uuid(),
    type: z.string().min(1).max(200),
    version: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()),
    actor: actorSchema,
    occurredAt: z.date(),
  })
  .strict();

/**
 * The shape callers of `EventStoreService.append()` supply: `streamId` is
 * passed as a separate argument (the stream being appended to), and
 * `version` is assigned by the store itself — neither may be smuggled in via
 * the event body. `.omit()` on a `.strict()` base preserves strictness (zod
 * v4's `mergeDefs` carries the `catchall: never()` from the base schema
 * forward), so both fields remain rejected as unknown extra keys, not merely
 * "not required."
 */
export const newDomainEventSchema = domainEventSchema.omit({ streamId: true, version: true });

export type Actor = z.infer<typeof actorSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type NewDomainEvent = z.infer<typeof newDomainEventSchema>;
