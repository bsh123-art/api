import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests — please slow down and try again shortly' },
  });
};

// Keyed by IP (the library's default, which handles IPv6 correctly). A single
// shop shares one address, so the budget is sized for a whole counter.
export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

/** Aggressive limiter for credential endpoints to blunt brute-force attempts. */
export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler,
});
