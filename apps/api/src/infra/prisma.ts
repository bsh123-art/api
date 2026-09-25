import { Prisma, PrismaClient } from '@prisma/client';
import { isProd } from '../config/env';
import { logger } from '../core/logger';

// Allow a bounded pool override without rewriting or exposing database credentials.
const configuredDatabaseUrl = (): string | undefined => {
  const limit = process.env.PRISMA_CONNECTION_LIMIT;
  if (!limit) return undefined;
  if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 20) {
    throw new Error('PRISMA_CONNECTION_LIMIT must be an integer between 1 and 20');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('connection_limit', limit);
  return url.toString();
};

const datasourceUrl = configuredDatabaseUrl();

const createClient = () =>
  new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'query' },
    ],
  });

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

prisma.$on('error', (event) => logger.error({ target: event.target, message: event.message }, 'Prisma error'));
prisma.$on('warn', (event) => logger.warn({ target: event.target, message: event.message }, 'Prisma warning'));

// Surface slow queries in development without drowning the log in noise.
prisma.$on('query', (event) => {
  if (!isProd && event.duration > 250) logger.debug({ ms: event.duration, query: event.query }, 'Slow query');
});

// Reuse the client across hot reloads so dev never exhausts the connection pool.
if (!isProd) globalForPrisma.prisma = prisma;

/** Transaction-scoped client. Services accept this so they compose inside a tx. */
export type Tx = Prisma.TransactionClient;

/**
 * `PrismaClient` is structurally assignable to `TransactionClient`, so a single
 * alias accepts both. A union here would break Prisma's generic inference and
 * strip `include` results back to the bare model type.
 */
export type DbClient = Prisma.TransactionClient;
