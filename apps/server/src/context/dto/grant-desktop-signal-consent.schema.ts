import { z } from 'zod';

/**
 * The closed set of desktop signal types (ADR-0020). Shared between the
 * POST body schema below and the `:signalType` path param on GET/DELETE
 * (`desktop-signal-consents.controller.ts`) — security-reviewer finding:
 * the path param must be validated too, not just the body, so an
 * out-of-range value 400s cleanly instead of hitting the `varchar(30)`
 * column constraint as an unhandled driver error.
 */
export const desktopSignalTypeSchema = z.enum(['calendar-status', 'active-window']);

/**
 * Validates a `POST /workspaces/:workspaceId/context/desktop-signal-consents`
 * request body. Deliberately NOT `.strict()`: self-service by construction
 * (ADR-0020 Karar a) means the SESSION user (`req.user.id`) is the only
 * source of user identity — an extra `userId` key in the body is a harmless,
 * silently-stripped no-op, not a validation error. `.strict()` would 400 a
 * request that should instead succeed and ignore the extra key.
 */
export const grantDesktopSignalConsentSchema = z.object({
  signalType: desktopSignalTypeSchema,
});

export type GrantDesktopSignalConsentInput = z.infer<typeof grantDesktopSignalConsentSchema>;
