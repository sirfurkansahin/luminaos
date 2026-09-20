import { z } from 'zod';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(8).max(200),
    newPassword: z.string().min(12).max(200),
  })
  .strict()
  .refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, {
    message: 'New password must be different from the current password.',
    path: ['newPassword'],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
