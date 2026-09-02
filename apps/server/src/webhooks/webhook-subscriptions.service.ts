import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';

import {
  encryptSecret,
  ForbiddenError,
  InvalidObjectStateError,
  NotFoundError,
  ValidationError,
} from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { assertSafeWebhookUrl } from './ssrf-guard.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { webhookSubscriptions } from '../db/schema/webhook-subscriptions.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const ALLOWED_EVENT_TYPES = ['ActionsProposed', 'ActionsDecided'] as const;
type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

const SIGNING_SECRET_BYTE_LENGTH = 32;

export interface CreateWebhookSubscriptionInput {
  targetUrl: string;
  eventTypes: string[];
}

export interface WebhookSubscriptionRecord {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  createdAt: Date;
}

export interface CreatedWebhookSubscription extends WebhookSubscriptionRecord {
  signingSecret: string;
}

/**
 * F2-T16 PR1 (ADR-0033 §e/§g/§h): a flat, non-event-sourced CRUD service for
 * outbound webhook subscriptions -- structurally the same shape as
 * `ConnectorCredentialsService` (F2-T9/ADR-0025), NOT
 * `AutomationTriggersService`'s event-sourced pattern, since a subscription
 * has no consuming domain state machine.
 *
 * RBAC deliberately deviates from `AutomationTriggersService` (ADR-0033 §g):
 * a subscription's mere existence + target URL is itself a
 * data-exfiltration-adjacent signal, so BOTH reads (`list`) and writes
 * (`create`/`remove`) require `admin`+ -- there is no `member`-read
 * carve-out.
 */
@Injectable()
export class WebhookSubscriptionsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: CreateWebhookSubscriptionInput,
  ): Promise<CreatedWebhookSubscription> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    this.assertValidEventTypes(input.eventTypes);

    // Never persists a row for a rejected URL (ADR-0033 Karar a/b) --
    // this throws BEFORE any insert is attempted.
    await assertSafeWebhookUrl(input.targetUrl);

    const signingSecret = randomBytes(SIGNING_SECRET_BYTE_LENGTH).toString('hex');
    const encryptedSigningSecret = this.encrypt(signingSecret);
    const now = new Date();

    const [row] = await this.db
      .insert(webhookSubscriptions)
      .values({
        id: ulid(),
        workspaceId,
        targetUrl: input.targetUrl,
        eventTypes: input.eventTypes,
        encryptedSigningSecret,
        createdByUserId: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      throw new InvalidObjectStateError(
        'Failed to create webhook subscription: insert returned no row.',
      );
    }

    return {
      id: row.id,
      targetUrl: row.targetUrl,
      eventTypes: row.eventTypes as string[],
      createdAt: row.createdAt,
      signingSecret,
    };
  }

  async list(
    workspaceId: string,
    callerRole: MembershipRole,
  ): Promise<WebhookSubscriptionRecord[]> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select({
        id: webhookSubscriptions.id,
        targetUrl: webhookSubscriptions.targetUrl,
        eventTypes: webhookSubscriptions.eventTypes,
        createdAt: webhookSubscriptions.createdAt,
      })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.workspaceId, workspaceId),
          eq(webhookSubscriptions.lifecycle, 'active'),
        ),
      );

    return rows.map((row) => ({
      id: row.id,
      targetUrl: row.targetUrl,
      eventTypes: row.eventTypes as string[],
      createdAt: row.createdAt,
    }));
  }

  async remove(
    workspaceId: string,
    subscriptionId: string,
    callerRole: MembershipRole,
  ): Promise<void> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const [row] = await this.db
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.id, subscriptionId),
          eq(webhookSubscriptions.workspaceId, workspaceId),
          eq(webhookSubscriptions.lifecycle, 'active'),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundError('Webhook subscription not found');
    }

    // Soft-delete (mirrors `AutomationTriggersService`/`list()`'s own
    // `lifecycle`-filtered read) rather than a hard `DELETE` -- PR2's
    // `webhook_deliveries` rows FK-cascade off `webhook_subscriptions.id`, so
    // a hard delete here would silently erase delivery/audit history for a
    // removed subscription.
    await this.db
      .update(webhookSubscriptions)
      .set({ lifecycle: 'deleted', updatedAt: new Date() })
      .where(eq(webhookSubscriptions.id, subscriptionId));
  }

  private assertValidEventTypes(eventTypes: string[]): void {
    if (eventTypes.length === 0) {
      throw new ValidationError('eventTypes must be a non-empty array');
    }

    const invalid = eventTypes.filter(
      (eventType) => !ALLOWED_EVENT_TYPES.includes(eventType as AllowedEventType),
    );

    if (invalid.length > 0) {
      throw new ValidationError(
        `eventTypes contains unsupported value(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_EVENT_TYPES.join(', ')}`,
      );
    }
  }

  private encrypt(plaintext: string): string {
    if (env.encryptionKey === undefined) {
      throw new InvalidObjectStateError(
        'ENCRYPTION_KEY is not configured; webhook subscription storage is unavailable',
      );
    }

    return encryptSecret(plaintext, env.encryptionKey);
  }
}
