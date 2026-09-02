import { z } from 'zod';

/**
 * Validates a `POST /workspaces/:workspaceId/webhooks` request body.
 *
 * This DTO only SHAPE-checks (string/array typing) -- the real business-rule
 * validation (HTTPS-only + private/reserved-IP rejection via
 * `assertSafeWebhookUrl`, and the `['ActionsProposed', 'ActionsDecided']`
 * allow-list) is enforced by `WebhookSubscriptionsService.create`, the
 * single source of truth for it, same DTO-vs-domain split as
 * `create-trigger.schema.ts`'s own documented reasoning (ADR-0033 §c).
 */
export const createWebhookSubscriptionSchema = z
  .object({
    targetUrl: z.string().min(1),
    eventTypes: z.array(z.string()),
  })
  .strict();

export type CreateWebhookSubscriptionInput = z.infer<typeof createWebhookSubscriptionSchema>;
