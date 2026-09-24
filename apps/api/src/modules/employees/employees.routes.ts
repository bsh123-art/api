import { Router } from 'express';
import { EmploymentStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize, requireBranch, requireUser, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import { passwordSchema } from '../auth/auth.schema';
import * as service from './employees.service';

const idParam = z.string().uuid();

const employeeSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).nullish(),
  role: z.nativeEnum(Role),
  branchId: z.string().uuid().nullish(),
  hourlyRate: z.number().min(0).nullish(),
  hiredAt: z.coerce.date().nullish(),
  status: z.nativeEnum(EmploymentStatus).optional(),
});

export const employeesRouter = Router();

// --- Shifts (any signed-in staff member manages their own drawer) ------------
const shiftRouter = Router();
shiftRouter.use(resolveBranch);

shiftRouter.get(
  '/current',
  asyncHandler(async (req, res) => ok(res, await service.currentShift(requireBranch(req), requireUser(req).sub))),
);

shiftRouter.post(
  '/open',
  validateBody(z.object({ openingCash: z.number().min(0) })),
  audit('shift.open', 'Shift'),
  asyncHandler(async (req, res) =>
    created(res, await service.openShift(requireBranch(req), requireUser(req).sub, req.body.openingCash)),
  ),
);

shiftRouter.post(
  '/close',
  validateBody(z.object({ closingCash: z.number().min(0), note: z.string().max(255).optional() })),
  audit('shift.close', 'Shift'),
  asyncHandler(async (req, res) =>
    ok(res, await service.closeShift(requireBranch(req), requireUser(req).sub, req.body.closingCash, req.body.note)),
  ),
);

shiftRouter.get(
  '/',
  authorize('MANAGER'),
  validateQuery(paginationSchema.extend({ userId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & { userId?: string; from?: Date; to?: Date };
    const { items, total } = await service.listShifts(requireBranch(req), { ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

employeesRouter.use('/shifts', shiftRouter);

// --- Employee administration (managers and above) ---------------------------
employeesRouter.use(authorize('MANAGER'));

employeesRouter.get(
  '/',
  validateQuery(
    paginationSchema.extend({
      role: z.nativeEnum(Role).optional(),
      status: z.nativeEnum(EmploymentStatus).optional(),
      branchId: z.string().uuid().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & { role?: Role; status?: EmploymentStatus; branchId?: string };
    const { items, total } = await service.listEmployees({ ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

employeesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => ok(res, await service.getEmployee(idParam.parse(req.params.id)))),
);

employeesRouter.post(
  '/',
  authorize(),
  validateBody(employeeSchema),
  audit('employee.create', 'User'),
  asyncHandler(async (req, res) => created(res, await service.createEmployee(req.body))),
);

employeesRouter.patch(
  '/:id',
  authorize(),
  validateBody(employeeSchema.partial().omit({ password: true })),
  audit('employee.update', 'User'),
  asyncHandler(async (req, res) => ok(res, await service.updateEmployee(idParam.parse(req.params.id), req.body))),
);

employeesRouter.post(
  '/:id/reset-password',
  authorize(),
  validateBody(z.object({ newPassword: passwordSchema })),
  audit('employee.reset_password', 'User'),
  asyncHandler(async (req, res) => {
    await service.resetPassword(idParam.parse(req.params.id), req.body.newPassword);
    return noContent(res);
  }),
);

employeesRouter.delete(
  '/:id',
  authorize(),
  audit('employee.deactivate', 'User'),
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    if (id === requireUser(req).sub) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'You cannot deactivate your own account' } });
    }
    await service.deactivateEmployee(id);
    return noContent(res);
  }),
);
