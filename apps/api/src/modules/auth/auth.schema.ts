import { z } from 'zod';

/** Enforces a reasonable password policy without being hostile to staff. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Password must include an uppercase letter, a lowercase letter and a number',
  });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required').max(128),
});

export const pinLoginSchema = z.object({
  employeeCode: z.string().trim().min(1).max(32),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'),
  currentPassword: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type PinLoginInput = z.infer<typeof pinLoginSchema>;
