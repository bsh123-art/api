import pino from 'pino';
import pretty from 'pino-pretty';
import { env, isProd } from '../config/env';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.pin',
  'res.headers["set-cookie"]',
  'passwordHash',
  'pinHash',
  'tokenHash',
];

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'kopi-api', env: env.NODE_ENV },
};

// pino-pretty is attached as a plain stream rather than a `transport`. The
// worker-thread transport silently stalls process startup on Windows.
export const logger = isProd
  ? pino(options)
  : pino(options, pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service,env' }));
