import { z } from "zod";

export const loginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
