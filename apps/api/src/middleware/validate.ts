import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type AnyZodObject, type ZodTypeAny } from 'zod';
import { ValidationError } from '../core/errors';

type Source = 'body' | 'query' | 'params';

const formatIssues = (error: ZodError) =>
  error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));

/** Validates and replaces `req[source]` with the parsed, typed result. */
export const validate =
  (schema: ZodTypeAny, source: Source = 'body'): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(new ValidationError(formatIssues(result.error)));
    // `req.query` is a getter in Express 5 — assign defensively.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    return next();
  };

export const validateBody = (schema: AnyZodObject | ZodTypeAny) => validate(schema, 'body');
export const validateQuery = (schema: AnyZodObject | ZodTypeAny) => validate(schema, 'query');
export const validateParams = (schema: AnyZodObject | ZodTypeAny) => validate(schema, 'params');
