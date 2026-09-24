import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma';
import { logger } from '../core/logger';

const SENSITIVE_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'pin',
  'pinhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
]);

/** Strips credentials before anything is persisted to the audit trail. */
export function redact<T>(input: T): T {
  if (Array.isArray(input)) return input.map((v) => redact(v)) as unknown as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(value);
    }
    return out as unknown as T;
  }
  return input;
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  changes?: unknown;
  userId?: string | null;
  branchId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Writes an audit record. Never throws — auditing must not break a request. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        changes: entry.changes === undefined ? undefined : (redact(entry.changes) as Prisma.InputJsonValue),
        userId: entry.userId ?? null,
        branchId: entry.branchId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent?.slice(0, 255) ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, entry: { action: entry.action, entity: entry.entity } }, 'Failed to write audit log');
  }
}

/**
 * Declarative auditing for mutating routes. The record is written after the
 * response is flushed and only when the handler succeeded (2xx).
 */
export const audit =
  (action: string, entity: string, entityIdFrom: (req: Request, res: Response) => string | undefined = (req) => req.params.id): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      void writeAudit({
        action,
        entity,
        entityId: entityIdFrom(req, res) ?? null,
        changes: req.method === 'DELETE' ? undefined : req.body,
        userId: req.user?.sub ?? null,
        branchId: req.branchId ?? req.user?.branchId ?? null,
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
    });
    next();
  };
