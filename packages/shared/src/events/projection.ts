import type { DomainEvent } from './domain-event.js';

/**
 * Opaque handle for an in-flight database transaction, threaded through to
 * `Projection.apply`/`reset` by whatever runner drives a projection (see
 * `apps/server/src/event-store/projections/projection-runner.service.ts`).
 *
 * `packages/shared` is framework-free (CLAUDE.md: domain packages may not
 * import a framework/ORM), so this type deliberately cannot be Drizzle's real
 * transaction type. It carries no usable structure at this layer — concrete
 * projections living in `apps/server` cast it back to their real Drizzle
 * transaction handle (mirroring `EventStoreService`'s own `DbTransaction`
 * type, derived via `Parameters<Parameters<Database['transaction']>[0]>[0]`).
 * A branded empty-object type (rather than bare `unknown`) documents that
 * intent while still only being constructible via a cast, exactly as this
 * package's own tests do (`undefined as unknown as ProjectionTx`).
 */
export type ProjectionTx = { readonly __brand: 'ProjectionTx' };

/**
 * A derived read model, rebuildable at any time from the immutable event log
 * (CLAUDE.md, "Mimari Değişmezler": "tek doğruluk kaynağı olay günlüğüdür;
 * bağlam grafiği ve tüm projeksiyonlar türetilir"). `handles` lists the exact
 * `DomainEvent.type` values this projection cares about, or `['*']` to
 * receive every event regardless of type (see F0-T6's plan,
 * `giggly-brewing-moore.md`, for the wildcard rationale — a workspace-wide
 * counter, or a future context-fabric projection, needs every event).
 */
export interface Projection {
  /** Stable, unique identifier used as the `projection_checkpoints` row key. */
  readonly name: string;
  /** Event types this projection applies, or `['*']` for all event types. */
  readonly handles: readonly string[];
  /** Applies a single event's effect to this projection's own state. */
  apply(event: DomainEvent, tx: ProjectionTx): Promise<void>;
  /** Clears this projection's own state entirely, in preparation for a full replay. */
  reset(tx: ProjectionTx): Promise<void>;
}
