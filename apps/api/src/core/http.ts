import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

/** Wraps an async handler so rejected promises reach the error middleware. */
export const asyncHandler =
  <T extends RequestHandler>(fn: T): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Endpoints may attach extra summary values (revenue, unread count, ...). */
  [key: string]: unknown;
}

export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>) =>
  res.status(200).json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = <T>(res: Response, data: T) => res.status(201).json({ success: true, data });

export const noContent = (res: Response) => res.status(204).send();

export const paginated = <T>(res: Response, items: T[], meta: PageMeta) =>
  res.status(200).json({ success: true, data: items, meta });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  sortBy: z.string().trim().max(60).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Query-string boolean. `z.coerce.boolean()` cannot be used here because it
 * follows JS truthiness, which makes the string "false" evaluate to true.
 */
export const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

export type Pagination = z.infer<typeof paginationSchema>;

export const buildPageMeta = (total: number, page: number, pageSize: number): PageMeta => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

export const skipTake = (p: Pick<Pagination, 'page' | 'pageSize'>) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});
