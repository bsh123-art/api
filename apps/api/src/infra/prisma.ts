import { Prisma, PrismaClient } from '@prisma/client';
import { isProd } from '../config/env';
import { logger } from '../core/logger';

const createClient = () =>
  new PrismaClient({
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
