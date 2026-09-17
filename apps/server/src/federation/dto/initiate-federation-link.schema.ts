import { z } from 'zod';

export const initiateFederationLinkSchema = z.object({
  counterpartWorkspaceId: z.uuid(),
});

export type InitiateFederationLinkInput = z.infer<typeof initiateFederationLinkSchema>;
