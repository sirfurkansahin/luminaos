import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { triggerTemplateSuggestions } from '../db/schema/trigger-template-suggestions.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ActionProposalProjection`/`RelationsViewProjection`/`AIUsageProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

function requireStringPayloadField(event: DomainEvent, field: string): string {
  const value = event.payload[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

function requireObjectPayloadField(event: DomainEvent, field: string): Record<string, unknown> {
  const value = event.payload[field];

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value as Record<string, unknown>;
}

/**
 * `trigger_template_suggestions` read-model projection (F2-T17 PR2,
 * ADR-0034 §c/§d): one row per suggestion, keyed by `suggestionId`
 * (`trigger_template_suggestions.id`, a ULID). `TriggerTemplateSuggested`
 * inserts the row (idempotent, mirroring `AIUsageProjection`'s
 * `onConflictDoNothing` convention); `TriggerTemplateApproved`/
 * `TriggerTemplateRejected` update the SAME row (matched by `suggestionId`) —
 * mirroring `ActionProposalProjection`'s exact "switch on event.type, same
 * table, one event type per lifecycle stage" shape, since a suggestion has a
 * `pending -> approved|rejected` state machine just like a `command_proposals`
 * row does.
 */
export class TriggerTemplateSuggestionProjection implements Projection {
  readonly name = 'trigger-template-suggestion';
  readonly handles: readonly string[] = [
    'TriggerTemplateSuggested',
    'TriggerTemplateApproved',
    'TriggerTemplateRejected',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'TriggerTemplateSuggested': {
        const suggestionId = requireStringPayloadField(event, 'suggestionId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const name = requireStringPayloadField(event, 'name');
        const kind = requireStringPayloadField(event, 'kind');
        const spec = requireObjectPayloadField(event, 'spec');
        const rationale = requireStringPayloadField(event, 'rationale');

        await dbTx
          .insert(triggerTemplateSuggestions)
          .values({
            id: suggestionId,
            streamId: event.streamId,
            workspaceId,
            name,
            kind,
            spec,
            rationale,
            status: 'pending',
            createdTriggerId: null,
            createdAt: event.occurredAt,
            decidedAt: null,
          })
          .onConflictDoNothing({ target: triggerTemplateSuggestions.id });
        return;
      }
      case 'TriggerTemplateApproved': {
        const suggestionId = requireStringPayloadField(event, 'suggestionId');
        const createdTriggerId = requireStringPayloadField(event, 'createdTriggerId');

        await dbTx
          .update(triggerTemplateSuggestions)
          .set({ status: 'approved', createdTriggerId, decidedAt: event.occurredAt })
          .where(eq(triggerTemplateSuggestions.id, suggestionId));
        return;
      }
      case 'TriggerTemplateRejected': {
        const suggestionId = requireStringPayloadField(event, 'suggestionId');

        await dbTx
          .update(triggerTemplateSuggestions)
          .set({ status: 'rejected', decidedAt: event.occurredAt })
          .where(eq(triggerTemplateSuggestions.id, suggestionId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(triggerTemplateSuggestions);
  }
}
