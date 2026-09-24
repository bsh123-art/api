import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../core/errors';
import { logger } from '../core/logger';
import { isProd } from '../config/env';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown; stack?: string };
}

const PRISMA_MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  P2002: { status: 409, code: 'CONFLICT', message: 'A record with these unique values already exists' },
  P2003: { status: 409, code: 'FK_CONSTRAINT', message: 'Related record is missing or still referenced' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Record not found' },
  P2014: { status: 409, code: 'RELATION_VIOLATION', message: 'This change violates a required relation' },
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
  } satisfies ErrorBody);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = PRISMA_MESSAGES[err.code];
    status = mapped?.status ?? 400;
    code = mapped?.code ?? 'DATABASE_ERROR';
    message = mapped?.message ?? 'Database request failed';
    const target = (err.meta?.target as string[] | undefined)?.join(', ');
    if (target) details = { fields: target };
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    status = 400;
    code = 'DATABASE_VALIDATION';
    message = 'Invalid database query';
  }

  const log = { err, status, code, path: req.originalUrl, method: req.method, userId: req.user?.sub };
  if (status >= 500) logger.error(log, message);
  else logger.warn(log, message);

  const body: ErrorBody = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  // Stack traces are development-only — they leak internal paths otherwise.
  if (!isProd && err instanceof Error) body.error.stack = err.stack;

  res.status(status).json(body);
}
