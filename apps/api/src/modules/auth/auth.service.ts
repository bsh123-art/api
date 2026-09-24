import argon2 from 'argon2';
import { EmploymentStatus, type User } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
import { logger } from '../../core/logger';
import { prisma } from '../../infra/prisma';
import {
  hashToken,
  newId,
  refreshTokenExpiry,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type AccessTokenPayload,
} from './auth.tokens';

const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain: string) => argon2.hash(plain, ARGON_OPTIONS);
export const verifyPassword = (hash: string, plain: string) => argon2.verify(hash, plain);

export interface SessionContext {
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export type PublicUser = ReturnType<typeof toPublicUser>;

export function toPublicUser(user: User & { branch?: { id: string; name: string; code: string } | null }) {
  return {
    id: user.id,
    employeeCode: user.employeeCode,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    avatarUrl: user.avatarUrl,
    branchId: user.branchId,
    branch: user.branch ?? null,
    hasPin: Boolean(user.pinHash),
    lastLoginAt: user.lastLoginAt,
  };
}

const buildPayload = (user: User): AccessTokenPayload => ({
  sub: user.id,
  email: user.email,
  role: user.role,
  branchId: user.branchId,
  fullName: user.fullName,
});

async function issueSession(user: User, ctx: SessionContext, familyId = newId()): Promise<AuthResult> {
  const jti = newId();
  const refreshToken = signRefreshToken({ sub: user.id, familyId, jti });

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId: user.id,
      familyId,
      expiresAt: refreshTokenExpiry(),
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
      ipAddress: ctx.ipAddress ?? null,
    },
  });

  const full = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    include: { branch: { select: { id: true, name: true, code: true } } },
  });

  return { accessToken: signAccessToken(buildPayload(user)), refreshToken, user: toPublicUser(full) };
}

function assertUsable(user: User): void {
  if (user.deletedAt) throw new UnauthorizedError('Invalid credentials');
  if (user.status !== EmploymentStatus.ACTIVE) {
    throw new ForbiddenError('This account is not active. Contact an administrator.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new ForbiddenError(`Account temporarily locked. Try again in ${minutes} minute(s).`);
  }
}

async function registerFailure(user: User): Promise<void> {
  const failedLogins = user.failedLogins + 1;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLogins,
      lockedUntil: failedLogins >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_DURATION_MS) : null,
    },
  });
  if (failedLogins >= MAX_FAILED_LOGINS) {
    logger.warn({ userId: user.id }, 'Account locked after repeated failed logins');
  }
}

export async function login(email: string, password: string, ctx: SessionContext): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always spend time hashing so response timing cannot enumerate accounts.
  if (!user) {
    await argon2.hash(password, ARGON_OPTIONS).catch(() => undefined);
    throw new UnauthorizedError('Invalid email or password');
  }

  assertUsable(user);

  const valid = await verifyPassword(user.passwordHash, password).catch(() => false);
  if (!valid) {
    await registerFailure(user);
    throw new UnauthorizedError('Invalid email or password');
  }

  const fresh = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return issueSession(fresh, ctx);
}

/** Fast terminal switching: employee code + PIN, cashier shift hand-over. */
export async function loginWithPin(employeeCode: string, pin: string, ctx: SessionContext): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { employeeCode } });
  if (!user?.pinHash) throw new UnauthorizedError('Invalid employee code or PIN');

  assertUsable(user);

  const valid = await verifyPassword(user.pinHash, pin).catch(() => false);
  if (!valid) {
    await registerFailure(user);
    throw new UnauthorizedError('Invalid employee code or PIN');
  }

  const fresh = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return issueSession(fresh, ctx);
}

/**
 * Rotates a refresh token. If a token that was already rotated is replayed the
 * whole family is revoked — that is the classic stolen-token signal.
 */
export async function refreshSession(token: string, ctx: SessionContext): Promise<AuthResult> {
  const payload = verifyRefreshToken(token);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });

  if (!stored) {
    await prisma.refreshToken.updateMany({
      where: { familyId: payload.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ userId: payload.sub, familyId: payload.familyId }, 'Refresh token reuse detected — family revoked');
    throw new UnauthorizedError('Session is no longer valid, please sign in again');
  }

  if (stored.revokedAt || stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Session expired, please sign in again');
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user) throw new UnauthorizedError();
  assertUsable(user);

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  return issueSession(user, ctx, stored.familyId);
}

export async function logout(token?: string): Promise<void> {
  if (!token) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAll(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { branch: { select: { id: true, name: true, code: true } } },
  });
  if (!user) throw new UnauthorizedError();
  return toPublicUser(user);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const valid = await verifyPassword(user.passwordHash, currentPassword).catch(() => false);
  if (!valid) throw new UnauthorizedError('Current password is incorrect');

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  // Force every other device to re-authenticate with the new credential.
  await logoutAll(userId);
}

export async function setPin(userId: string, currentPassword: string, pin: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const valid = await verifyPassword(user.passwordHash, currentPassword).catch(() => false);
  if (!valid) throw new UnauthorizedError('Current password is incorrect');

  await prisma.user.update({ where: { id: userId }, data: { pinHash: await hashPassword(pin) } });
}

/** Housekeeping — invoked on a timer from the server bootstrap. */
export async function purgeExpiredTokens(): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 86_400_000) } }] },
  });
  return count;
}
