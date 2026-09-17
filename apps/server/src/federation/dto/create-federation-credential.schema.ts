import { z } from 'zod';

/**
 * F3-T14 PR2 (ADR-0048 §d, İNSAN ONAYLI, HTTP boundary): the SAME closed
 * 30/90/365-day union `FederationLinkCredentialsService.grant` enforces at
 * runtime -- `expiresAtDays` is OPTIONAL here (the service defaults to 90),
 * but if supplied it must be one of the three allowed values. "Süresiz" is
 * never a valid shape, at either layer.
 */
export const createFederationCredentialSchema = z.object({
  name: z.string().min(1).max(200),
  expiresAtDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).optional(),
});

export type CreateFederationCredentialInput = z.infer<typeof createFederationCredentialSchema>;
