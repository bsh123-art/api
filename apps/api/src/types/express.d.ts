import type { Role } from '@prisma/client';
import type { AccessTokenPayload } from '../modules/auth/auth.tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      /** Branch the current request operates on, resolved by `resolveBranch`. */
      branchId?: string;
      auditContext?: { action: string; entity: string; entityId?: string; changes?: unknown };
    }
  }
}

export type { Role, AccessTokenPayload };
