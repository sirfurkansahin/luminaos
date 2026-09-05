import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agents } from '../db/schema/agents.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `AutomationTriggersViewProjection`'s own `asDbTransaction`). */
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

/**
 * `agents` read-model projection (F3-T3, ADR-0037 Karar b) — mirrors
 * `AutomationTriggersViewProjection`'s exact shape. `AgentDeactivated` does
 * NOT hard-delete the row — it sets `lifecycle: 'deactivated'`.
 */
export class AgentDirectoryProjection implements Projection {
  readonly name = 'agent-directory';
  readonly handles: readonly string[] = ['AgentRegistered', 'AgentDeactivated'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'AgentRegistered': {
        const agentId = requireStringPayloadField(event, 'agentId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const name = requireStringPayloadField(event, 'name');
        const agentIdentifier = requireStringPayloadField(event, 'agentIdentifier');

        await dbTx.insert(agents).values({
          id: agentId,
          streamId: event.streamId,
          workspaceId,
          name,
          agentIdentifier,
          lifecycle: 'active',
          createdAt: event.occurredAt,
        });
        return;
      }
      case 'AgentDeactivated': {
        const agentId = requireStringPayloadField(event, 'agentId');

        await dbTx.update(agents).set({ lifecycle: 'deactivated' }).where(eq(agents.id, agentId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(agents);
  }
}
