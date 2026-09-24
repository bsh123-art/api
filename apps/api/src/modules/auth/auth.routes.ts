import { Router, type CookieOptions, type Request, type Response } from 'express';
import { env, isProd } from '../../config/env';
import { asyncHandler, noContent, ok } from '../../core/http';
import { authenticate, requireUser } from '../../middleware/auth';
import { writeAudit } from '../../middleware/audit';
import { authLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import * as service from './auth.service';
import { changePasswordSchema, loginSchema, pinLoginSchema, setPinSchema } from './auth.schema';

const REFRESH_COOKIE = 'kopi_rt';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE || isProd,
  sameSite: 'lax',
  path: '/api/v1/auth',
  domain: env.COOKIE_DOMAIN || undefined,
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

const sessionContext = (req: Request) => ({
  userAgent: req.get('user-agent') ?? undefined,
  ipAddress: req.ip ?? undefined,
});

/** Refresh tokens live in an httpOnly cookie so XSS cannot exfiltrate them. */
const sendSession = (res: Response, result: service.AuthResult) => {
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions());
  return ok(res, { accessToken: result.accessToken, user: result.user });
};

export const authRouter = Router();

authRouter.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await service.login(email, password, sessionContext(req));
    await writeAudit({
      action: 'auth.login',
      entity: 'User',
      entityId: result.user.id,
      userId: result.user.id,
      branchId: result.user.branchId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return sendSession(res, result);
  }),
);

authRouter.post(
  '/login/pin',
  authLimiter,
  validateBody(pinLoginSchema),
  asyncHandler(async (req, res) => {
    const { employeeCode, pin } = req.body;
    const result = await service.loginWithPin(employeeCode, pin, sessionContext(req));
    return sendSession(res, result);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body?.refreshToken as string | undefined);
    const result = await service.refreshSession(token ?? '', sessionContext(req));
    return sendSession(res, result);
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await service.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    return noContent(res);
  }),
);

authRouter.use(authenticate);

authRouter.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, await service.getProfile(requireUser(req).sub))),
);

authRouter.post(
  '/logout-all',
  asyncHandler(async (req, res) => {
    await service.logoutAll(requireUser(req).sub);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    return noContent(res);
  }),
);

authRouter.post(
  '/change-password',
  authLimiter,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    await service.changePassword(user.sub, req.body.currentPassword, req.body.newPassword);
    await writeAudit({ action: 'auth.password_changed', entity: 'User', entityId: user.sub, userId: user.sub, ipAddress: req.ip });
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    return noContent(res);
  }),
);

authRouter.post(
  '/set-pin',
  authLimiter,
  validateBody(setPinSchema),
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    await service.setPin(user.sub, req.body.currentPassword, req.body.pin);
    await writeAudit({ action: 'auth.pin_set', entity: 'User', entityId: user.sub, userId: user.sub });
    return noContent(res);
  }),
);
