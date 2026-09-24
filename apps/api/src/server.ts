import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './core/logger';
import { prisma } from './infra/prisma';
import { initRealtime, shutdownRealtime } from './infra/realtime';
import { purgeExpiredTokens } from './modules/auth/auth.service';
import { pruneBackups } from './modules/platform/backup.service';

const server = http.createServer(createApp());
initRealtime(server);

const HOUR = 60 * 60 * 1000;

const housekeeping = setInterval(() => {
  void purgeExpiredTokens()
    .then((count) => count > 0 && logger.info({ count }, 'Purged expired refresh tokens'))
    .catch((err) => logger.error({ err }, 'Token purge failed'));

  void pruneBackups(30)
    .then((count) => count > 0 && logger.info({ count }, 'Pruned old backups'))
    .catch((err) => logger.error({ err }, 'Backup prune failed'));
}, 6 * HOUR);
housekeeping.unref();

async function start(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connection established');

  server.listen(env.API_PORT, () => {
    logger.info(`Kopi POS API listening on http://localhost:${env.API_PORT} (${env.NODE_ENV})`);
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');

  clearInterval(housekeeping);
  shutdownRealtime();

  // Stop accepting connections, then drain, then release the database.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref());
  await Promise.race([closed, timeout]);

  await prisma.$disconnect().catch((err) => logger.error({ err }, 'Error disconnecting Prisma'));
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
