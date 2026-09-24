import { Router } from 'express';
import { PurchaseOrderStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, buildPageMeta, created, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize, requireBranch, requireUser, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as service from './purchasing.service';

const idParam = z.string().uuid();

const poSchema = z.object({
  supplierId: z.string().uuid(),
  expectedAt: z.coerce.date().nullish(),
  shippingFee: z.number().min(0).optional(),
  taxAmount: z.number().min(0).optional(),
  note: z.string().max(500).nullish(),
  items: z
    .array(
      z.object({
        ingredientId: z.string().uuid(),
        quantity: z.number().positive(),
        unitCost: z.number().min(0),
      }),
    )
    .min(1, 'A purchase order needs at least one item'),
});

const receiveSchema = z.object({
  note: z.string().max(255).optional(),
  receipts: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        receivedQty: z.number().min(0),
        actualUnitCost: z.number().min(0).optional(),
      }),
    )
    .min(1),
});

export const purchasingRouter = Router();
purchasingRouter.use(resolveBranch, authorize('MANAGER'));

purchasingRouter.get(
  '/reorder-suggestions',
  asyncHandler(async (req, res) => ok(res, await service.reorderSuggestions(requireBranch(req)))),
);

purchasingRouter.get(
  '/',
  validateQuery(paginationSchema.extend({ status: z.nativeEnum(PurchaseOrderStatus).optional(), supplierId: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & { status?: PurchaseOrderStatus; supplierId?: string };
    const { items, total } = await service.listPurchaseOrders(requireBranch(req), { ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

purchasingRouter.get(
  '/:id',
  asyncHandler(async (req, res) => ok(res, await service.getPurchaseOrder(requireBranch(req), idParam.parse(req.params.id)))),
);

purchasingRouter.post(
  '/',
  validateBody(poSchema),
  audit('purchase_order.create', 'PurchaseOrder'),
  asyncHandler(async (req, res) =>
    created(res, await service.createPurchaseOrder(requireBranch(req), requireUser(req).sub, req.body)),
  ),
);

purchasingRouter.patch(
  '/:id',
  validateBody(poSchema),
  audit('purchase_order.update', 'PurchaseOrder'),
  asyncHandler(async (req, res) =>
    ok(res, await service.updatePurchaseOrder(requireBranch(req), idParam.parse(req.params.id), req.body)),
  ),
);

purchasingRouter.post(
  '/:id/submit',
  audit('purchase_order.submit', 'PurchaseOrder'),
  asyncHandler(async (req, res) => ok(res, await service.submitPurchaseOrder(requireBranch(req), idParam.parse(req.params.id)))),
);

purchasingRouter.post(
  '/:id/receive',
  validateBody(receiveSchema),
  audit('purchase_order.receive', 'PurchaseOrder'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.receivePurchaseOrder(
        requireBranch(req),
        idParam.parse(req.params.id),
        requireUser(req).sub,
        req.body.receipts,
        req.body.note,
      ),
    ),
  ),
);

purchasingRouter.post(
  '/:id/cancel',
  validateBody(z.object({ reason: z.string().max(255).optional() })),
  audit('purchase_order.cancel', 'PurchaseOrder'),
  asyncHandler(async (req, res) =>
    ok(res, await service.cancelPurchaseOrder(requireBranch(req), idParam.parse(req.params.id), req.body.reason)),
  ),
);
