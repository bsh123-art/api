import { Router } from 'express';
import { NotificationType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, booleanQuery, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { prisma } from '../../infra/prisma';
import { authorize, requireBranch, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as backup from './backup.service';
import { getSettings, settingsSchema, updateSettings } from '../settings/settings.service';

const idParam = z.string().uuid();

export const platformRouter = Router();

// --- Branches ---------------------------------------------------------------
const branchSchema = z.object({
  code: z.string().trim().min(2).max(10).regex(/^[A-Z0-9]+$/, 'Use uppercase letters and digits only'),
  name: z.string().trim().min(1).max(120),
  address: z.string().max(255).nullish(),
  phone: z.string().max(32).nullish(),
  timezone: z.string().max(60).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

platformRouter.get(
  '/branches',
  asyncHandler(async (_req, res) =>
    ok(
      res,
      await prisma.branch.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { users: true, orders: true } } },
      }),
    ),
  ),
);

platformRouter.post(
  '/branches',
  authorize(),
  validateBody(branchSchema),
  audit('branch.create', 'Branch'),
  asyncHandler(async (req, res) => {
    const branch = await prisma.branch.create({ data: req.body });
    // A new branch starts with a zero row for every ingredient.
    const ingredients = await prisma.ingredient.findMany({ where: { isActive: true }, select: { id: true } });
    if (ingredients.length > 0) {
      await prisma.inventoryStock.createMany({
        data: ingredients.map((i) => ({ branchId: branch.id, ingredientId: i.id, quantity: 0 })),
        skipDuplicates: true,
      });
    }
    return created(res, branch);
  }),
);

platformRouter.patch(
  '/branches/:id',
  authorize(),
  validateBody(branchSchema.partial()),
  audit('branch.update', 'Branch'),
  asyncHandler(async (req, res) => ok(res, await prisma.branch.update({ where: { id: idParam.parse(req.params.id) }, data: req.body }))),
);

// --- Settings ---------------------------------------------------------------
platformRouter.get('/settings', asyncHandler(async (_req, res) => ok(res, await getSettings())));

platformRouter.patch(
  '/settings',
  authorize(),
  validateBody(settingsSchema.partial()),
  audit('settings.update', 'Setting'),
  asyncHandler(async (req, res) => ok(res, await updateSettings(req.body))),
);

// --- Notifications ----------------------------------------------------------
platformRouter.get(
  '/notifications',
  resolveBranch,
  validateQuery(paginationSchema.extend({ unreadOnly: booleanQuery, type: z.nativeEnum(NotificationType).optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & { unreadOnly?: boolean; type?: NotificationType };
    const where = {
      branchId: requireBranch(req),
      ...(query.unreadOnly ? { readAt: null } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { branchId: requireBranch(req), readAt: null } }),
    ]);

    return paginated(res, items, { ...buildPageMeta(total, query.page, query.pageSize), unread });
  }),
);

platformRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) =>
    ok(res, await prisma.notification.update({ where: { id: idParam.parse(req.params.id) }, data: { readAt: new Date() } })),
  ),
);

platformRouter.post(
  '/notifications/read-all',
  resolveBranch,
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.updateMany({
      where: { branchId: requireBranch(req), readAt: null },
      data: { readAt: new Date() },
    });
    return ok(res, { updated: count });
  }),
);

// --- Audit log --------------------------------------------------------------
platformRouter.get(
  '/audit-logs',
  authorize('MANAGER'),
  validateQuery(
    paginationSchema.extend({
      entity: z.string().max(60).optional(),
      action: z.string().max(60).optional(),
      userId: z.string().uuid().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & {
      entity?: string;
      action?: string;
      userId?: string;
      from?: Date;
      to?: Date;
    };

    const where = {
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.action ? { action: { contains: query.action, mode: 'insensitive' as const } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, fullName: true, employeeCode: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      prisma.auditLog.count({ where }),
    ]);

    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

// --- Backups (admin only) ---------------------------------------------------
const backupRouter = Router();
backupRouter.use(authorize());

backupRouter.get('/', asyncHandler(async (_req, res) => ok(res, await backup.listBackups())));

backupRouter.post(
  '/',
  validateBody(z.object({ format: z.enum(['sql', 'json']).default('sql') })),
  audit('backup.create', 'Backup'),
  asyncHandler(async (req, res) =>
    created(res, req.body.format === 'json' ? await backup.createJsonBackup() : await backup.createSqlBackup()),
  ),
);

backupRouter.get(
  '/:fileName/download',
  audit('backup.download', 'Backup', (req) => String(req.params.fileName)),
  asyncHandler(async (req, res) => {
    const { stream, fileName } = backup.streamBackup(String(req.params.fileName));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    stream.pipe(res);
  }),
);

backupRouter.delete(
  '/:fileName',
  audit('backup.delete', 'Backup', (req) => String(req.params.fileName)),
  asyncHandler(async (req, res) => {
    await backup.deleteBackup(String(req.params.fileName));
    return noContent(res);
  }),
);

platformRouter.use('/backups', backupRouter);
