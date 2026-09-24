import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env, isProd } from './config/env';
import { decimalJsonReplacer } from './core/money';
import { logger } from './core/logger';
import { prisma } from './infra/prisma';
import { errorHandler, notFoundHandler } from './middleware/error';
import { apiLimiter } from './middleware/rateLimit';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy/load balancer we must trust exactly one hop so that
  // `req.ip` is accurate for rate limiting and audit logs.
  app.set('trust proxy', isProd ? 1 : false);
  app.disable('x-powered-by');
  app.set('json replacer', decimalJsonReplacer);

  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and native/offline clients send no Origin header.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS policy'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Idempotency-Key'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'kopi-api', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', database: 'connected' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'disconnected' });
    }
  });

  app.use('/api/v1', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
