import { z } from 'zod';

/**
 * F2-T12 PR1 (ADR-0028 §k/§l): `expiresAtDays` is restricted to the fixed
 * 30/90/365-day menu -- no "indefinite" option, no client-supplied absolute
 * date (Karar l).
 */
export const createMcpClientGrantSchema = z.object({
  name: z.string().min(1).max(200),
  expiresAtDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
});

export type CreateMcpClientGrantInput = z.infer<typeof createMcpClientGrantSchema>;
