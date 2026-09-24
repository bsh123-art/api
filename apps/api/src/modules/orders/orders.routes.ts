import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, buildPageMeta, created, ok, paginated } from '../../core/http';
import { authorize, requireBranch, requireUser, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as service from './orders.service';
import { createOrderSchema, orderQuerySchema, quoteOrderSchema, refundOrderSchema, voidOrderSchema } from './orders.schema';

const idParam = z.string().uuid();

/** Offline terminals replay their queue here; each entry carries its own key. */
const syncSchema = z.object({ orders: z.array(createOrderSchema).min(1).max(100) });

export const ordersRouter = Router();
ordersRouter.use(resolveBranch);

ordersRouter.post(
  '/quote',
  validateBody(quoteOrderSchema),
  asyncHandler(async (req, res) => ok(res, await service.quote(req.body))),
);

ordersRouter.post(
  '/',
  validateBody(createOrderSchema),
  audit('order.create', 'Order', (req) => req.body.idempotencyKey),
  asyncHandler(async (req, res) => {
    const { order, duplicate } = await service.createOrder(req.body, {
      branchId: requireBranch(req),
      cashierId: requireUser(req).sub,
    });
    return duplicate ? ok(res, order, { duplicate: true }) : created(res, order);
  }),
);

/**
 * Bulk replay endpoint for offline mode. Each order is processed independently
 * so one bad entry never blocks the rest of the queue from syncing.
 */
ordersRouter.post(
  '/sync',
  validateBody(syncSchema),
  asyncHandler(async (req, res) => {
    const ctx = { branchId: requireBranch(req), cashierId: requireUser(req).sub };
    const results = [];

    for (const payload of req.body.orders as z.infer<typeof createOrderSchema>[]) {
      try {
        const { order, duplicate } = await service.createOrder(payload, ctx);
        results.push({
          idempotencyKey: payload.idempotencyKey,
          status: duplicate ? ('duplicate' as const) : ('synced' as const),
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
      } catch (err) {
        results.push({
          idempotencyKey: payload.idempotencyKey,
          status: 'failed' as const,
          error: err instanceof Error ? err.message : 'Unknown error',
          code: (err as { code?: string }).code ?? 'SYNC_FAILED',
        });
      }
    }

    return ok(res, results, {
      synced: results.filter((r) => r.status === 'synced').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
  }),
);

ordersRouter.get(
  '/',
  validateQuery(orderQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof orderQuerySchema>;
    const { items, total, summary } = await service.listOrders(requireBranch(req), query);
    return paginated(res, items, { ...buildPageMeta(total, query.page, query.pageSize), ...summary });
  }),
);

ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => ok(res, await service.getOrder(requireBranch(req), idParam.parse(req.params.id)))),
);

ordersRouter.get(
  '/:id/receipt',
  asyncHandler(async (req, res) => ok(res, await service.getReceipt(requireBranch(req), idParam.parse(req.params.id)))),
);

ordersRouter.post(
  '/:id/void',
  authorize('MANAGER'),
  validateBody(voidOrderSchema),
  audit('order.void', 'Order'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.voidOrder(
        requireBranch(req),
        idParam.parse(req.params.id),
        requireUser(req).sub,
        req.body.reason,
        req.body.restock,
      ),
    ),
  ),
);

ordersRouter.post(
  '/:id/refund',
  authorize('MANAGER'),
  validateBody(refundOrderSchema),
  audit('order.refund', 'Order'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.refundOrder(
        requireBranch(req),
        idParam.parse(req.params.id),
        requireUser(req).sub,
        req.body.reason,
        req.body.restock,
      ),
    ),
  ),
);
