import { Router } from 'express';
import { StockMovementType, UnitType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, booleanQuery, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize, requireBranch, requireUser, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as inventory from './inventory.service';
import * as ingredients from './ingredients.service';

const idParam = z.string().uuid();

const ingredientSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  unit: z.nativeEnum(UnitType),
  costPerUnit: z.number().min(0).optional(),
  lowStockAt: z.number().min(0).optional(),
  reorderQty: z.number().min(0).optional(),
  supplierId: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
  openingStock: z.number().min(0).optional(),
});

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().max(120).nullish(),
  phone: z.string().max(32).nullish(),
  email: z.string().email().max(120).nullish().or(z.literal('')),
  address: z.string().max(255).nullish(),
  paymentTerm: z.string().max(60).nullish(),
});

const adjustSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().refine((v) => v !== 0, 'Quantity cannot be zero'),
  type: z.nativeEnum(StockMovementType).default(StockMovementType.ADJUSTMENT),
  note: z.string().max(255).optional(),
});

const stocktakeSchema = z.object({
  note: z.string().max(255).optional(),
  counts: z
    .array(z.object({ ingredientId: z.string().uuid(), countedQty: z.number().min(0) }))
    .min(1, 'Add at least one counted item'),
});

const movementQuery = paginationSchema.extend({
  ingredientId: z.string().uuid().optional(),
  type: z.nativeEnum(StockMovementType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const ingredientQuery = paginationSchema.extend({
  supplierId: z.string().uuid().optional(),
  isActive: booleanQuery,
});

const stockQuery = z.object({
  search: z.string().trim().max(120).optional(),
  lowOnly: booleanQuery,
});

export const inventoryRouter = Router();
inventoryRouter.use(resolveBranch);

// --- Stock ------------------------------------------------------------------
inventoryRouter.get(
  '/stock',
  validateQuery(stockQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof stockQuery>;
    return ok(res, await inventory.listStock(requireBranch(req), { search: query.search, lowOnly: query.lowOnly }));
  }),
);

inventoryRouter.post(
  '/stock/adjust',
  authorize('MANAGER'),
  validateBody(adjustSchema),
  audit('inventory.adjust', 'InventoryStock', (req) => req.body.ingredientId),
  asyncHandler(async (req, res) =>
    ok(res, await inventory.adjustStock({ ...req.body, branchId: requireBranch(req), userId: requireUser(req).sub })),
  ),
);

inventoryRouter.post(
  '/stock/stocktake',
  authorize('MANAGER'),
  validateBody(stocktakeSchema),
  audit('inventory.stocktake', 'InventoryStock'),
  asyncHandler(async (req, res) =>
    ok(res, await inventory.stocktake({ ...req.body, branchId: requireBranch(req), userId: requireUser(req).sub })),
  ),
);

inventoryRouter.get(
  '/movements',
  validateQuery(movementQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof movementQuery>;
    const { items, total } = await inventory.listMovements(requireBranch(req), { ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

// --- Ingredients ------------------------------------------------------------
inventoryRouter.get(
  '/ingredients',
  validateQuery(ingredientQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof ingredientQuery>;
    const { items, total } = await ingredients.listIngredients({ ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

inventoryRouter.get(
  '/ingredients/:id',
  asyncHandler(async (req, res) => ok(res, await ingredients.getIngredient(idParam.parse(req.params.id)))),
);

inventoryRouter.post(
  '/ingredients',
  authorize('MANAGER'),
  validateBody(ingredientSchema),
  audit('ingredient.create', 'Ingredient'),
  asyncHandler(async (req, res) =>
    created(res, await ingredients.createIngredient(requireBranch(req), requireUser(req).sub, req.body)),
  ),
);

inventoryRouter.patch(
  '/ingredients/:id',
  authorize('MANAGER'),
  validateBody(ingredientSchema.partial()),
  audit('ingredient.update', 'Ingredient'),
  asyncHandler(async (req, res) => ok(res, await ingredients.updateIngredient(idParam.parse(req.params.id), req.body))),
);

inventoryRouter.delete(
  '/ingredients/:id',
  authorize('MANAGER'),
  audit('ingredient.archive', 'Ingredient'),
  asyncHandler(async (req, res) => {
    await ingredients.archiveIngredient(idParam.parse(req.params.id));
    return noContent(res);
  }),
);

// --- Suppliers --------------------------------------------------------------
inventoryRouter.get(
  '/suppliers',
  asyncHandler(async (req, res) => ok(res, await ingredients.listSuppliers(req.query.search as string | undefined))),
);

inventoryRouter.post(
  '/suppliers',
  authorize('MANAGER'),
  validateBody(supplierSchema),
  audit('supplier.create', 'Supplier'),
  asyncHandler(async (req, res) => created(res, await ingredients.createSupplier(req.body))),
);

inventoryRouter.patch(
  '/suppliers/:id',
  authorize('MANAGER'),
  validateBody(supplierSchema.partial()),
  audit('supplier.update', 'Supplier'),
  asyncHandler(async (req, res) => ok(res, await ingredients.updateSupplier(idParam.parse(req.params.id), req.body))),
);

inventoryRouter.delete(
  '/suppliers/:id',
  authorize('MANAGER'),
  audit('supplier.archive', 'Supplier'),
  asyncHandler(async (req, res) => {
    await ingredients.archiveSupplier(idParam.parse(req.params.id));
    return noContent(res);
  }),
);
