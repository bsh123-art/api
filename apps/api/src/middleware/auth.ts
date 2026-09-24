import type { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../core/errors';
import { prisma } from '../infra/prisma';
import { verifyAccessToken } from '../modules/auth/auth.tokens';

/** Verifies the bearer token and attaches the caller to the request. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();

  const token = header.slice(7).trim();
  if (!token) throw new UnauthorizedError();

  req.user = verifyAccessToken(token);
  next();
}

/** Restricts a route to the listed roles. ADMIN always passes. */
export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new UnauthorizedError();
    if (req.user.role !== Role.ADMIN && !roles.includes(req.user.role)) {
      throw new ForbiddenError(`Requires one of: ${[Role.ADMIN, ...roles].join(', ')}`);
    }
    next();
  };

export const adminOnly = authorize();
export const managerUp = authorize(Role.MANAGER);
export const anyStaff = authorize(Role.MANAGER, Role.CASHIER);

/**
 * Resolves the branch a request targets. Non-admins are locked to the branch on
 * their token; admins may target another branch via `?branchId=` or a header.
 */
export async function resolveBranch(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw new UnauthorizedError();

  const requested =
    (req.query.branchId as string | undefined) ??
    (req.headers['x-branch-id'] as string | undefined) ??
    (req.body?.branchId as string | undefined);

  if (req.user.role === Role.ADMIN) {
    if (requested) {
      req.branchId = requested;
    } else if (req.user.branchId) {
      req.branchId = req.user.branchId;
    } else {
      const fallback = await prisma.branch.findFirst({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!fallback) throw new ForbiddenError('No active branch is configured');
      req.branchId = fallback.id;
    }
    return next();
  }

  if (!req.user.branchId) throw new ForbiddenError('Your account is not assigned to a branch');
  if (requested && requested !== req.user.branchId) {
    throw new ForbiddenError('You may only access data for your own branch');
  }
  req.branchId = req.user.branchId;
  next();
}

/** Throws if the branch could not be resolved — use inside handlers. */
export function requireBranch(req: Request): string {
  if (!req.branchId) throw new ForbiddenError('Branch context is required');
  return req.branchId;
}

export function requireUser(req: Request) {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}
