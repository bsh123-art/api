import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as service from './customers.service';

const idParam = z.string().uuid();

const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).nullish(),
  email: z.string().email().max(120).nullish().or(z.literal('')),
  birthDate: z.coerce.date().nullish(),
  note: z.string().max(500).nullish(),
  isActive: z.boolean().optional(),
});

export const customersRouter = Router();

customersRouter.get(
  '/',
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema>;
    const { items, total } = await service.listCustomers({ ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => ok(res, await service.getCustomer(idParam.parse(req.params.id)))),
);

customersRouter.post(
  '/',
  validateBody(customerSchema),
  audit('customer.create', 'Customer'),
  asyncHandler(async (req, res) => created(res, await service.createCustomer(req.body))),
);

customersRouter.patch(
  '/:id',
  validateBody(customerSchema.partial()),
  audit('customer.update', 'Customer'),
  asyncHandler(async (req, res) => ok(res, await service.updateCustomer(idParam.parse(req.params.id), req.body))),
);

customersRouter.post(
  '/:id/redeem',
  validateBody(z.object({ points: z.number().int().positive() })),
  audit('customer.redeem_points', 'Customer'),
  asyncHandler(async (req, res) => ok(res, await service.redeemPoints(idParam.parse(req.params.id), req.body.points))),
);

customersRouter.delete(
  '/:id',
  authorize('MANAGER'),
  audit('customer.deactivate', 'Customer'),
  asyncHandler(async (req, res) => {
    await service.deactivateCustomer(idParam.parse(req.params.id));
    return noContent(res);
  }),
);
