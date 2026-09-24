import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../../config/env';
import { UnauthorizedError } from '../../core/errors';

const ISSUER = 'kopi-pos';
const AUDIENCE = 'kopi-pos-client';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  branchId: string | null;
  fullName: string;
}

export interface RefreshTokenPayload {
  sub: string;
  familyId: string;
  jti: string;
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  } as SignOptions);

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  } as SignOptions);

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER, audience: AUDIENCE }) as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError('Session expired');
    throw new UnauthorizedError('Invalid access token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, { issuer: ISSUER, audience: AUDIENCE }) as RefreshTokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }
}

/** Refresh tokens are stored hashed so a database leak cannot mint sessions. */
export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export const newId = (): string => crypto.randomUUID();

export function refreshTokenExpiry(): Date {
  const ttl = env.JWT_REFRESH_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = match ? Number(match[1]) * (units[match[2] as string] ?? 86_400_000) : 7 * 86_400_000;
  return new Date(Date.now() + ms);
}
