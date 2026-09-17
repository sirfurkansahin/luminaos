import { z } from 'zod';

export const addFederationScopeObjectSchema = z.object({
  objectId: z.string().min(1).max(26),
});

export type AddFederationScopeObjectInput = z.infer<typeof addFederationScopeObjectSchema>;
