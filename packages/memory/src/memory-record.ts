/**
 * `MemoryRecord` — the row-level shape of a Memory Passport entry, per
 * ADR-0022 Karar (b) (`docs/adr/ADR-0022-memory-passport.md`).
 *
 * Plain TypeScript interface, no runtime schema — matches
 * `packages/core-objects`'s `LuminaObject` precedent (a projection-row
 * shape, not a wire payload; wire payloads are validated at the event
 * boundary by `memory-record-events.ts`'s zod schemas instead).
 *
 * `kaynakOlayId`: in v1 this is ALWAYS the `id` of the `MemoryRecordAdded`
 * event that created the record (self-referential, never `null`) — see
 * ADR-0022 Karar (b) for the full semantics and its planned future
 * reinterpretation (automatic AI-derived memory, out of scope here).
 *
 * `deletedAt`: nullable tombstone timestamp, per ADR-0022 Karar (d) — set
 * when a `MemoryRecordDeleted` event is processed; the row is never
 * physically deleted, only filtered out of read queries.
 */
export interface MemoryRecord {
  id: string;
  workspaceId: string;
  userId: string;
  content: string;
  kaynakOlayId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
