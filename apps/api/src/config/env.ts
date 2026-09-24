import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load the repository-root .env first, then allow an app-local override.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

process.env.API_PORT ??= process.env.PORT;

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres connection string'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  COOKIE_SECURE: booleanish.default('false'),
  COOKIE_DOMAIN: z.string().optional(),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  BACKUP_DIR: z.string().default('./storage/backups'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@kopipos.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
  SEED_CASHIER_EMAIL: z.string().email().default('cashier@kopipos.local'),
  SEED_CASHIER_PASSWORD: z.string().min(8).default('ChangeMe123!'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast: a misconfigured secret must never silently fall back to a default.
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

if (isProd) {
  const weak = ['CHANGE_ME', 'changeme', 'secret', 'password'];
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (weak.some((w) => env[key].toLowerCase().includes(w.toLowerCase()))) {
      throw new Error(`${key} still contains a placeholder value — refusing to start in production.`);
    }
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
  }
}
