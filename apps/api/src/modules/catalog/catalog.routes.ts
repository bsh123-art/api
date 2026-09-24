import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, booleanQuery, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as service from './catalog.service';

const idParam = z.string().uuid();

const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #8B5E3C').optional(),
  icon: z.string().max(40).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const recipeLineSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().positive('Recipe quantity must be greater than zero'),
  isOptional: z.boolean().optional(),
});

const variantSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(40),
  sku: z.string().trim().max(40).nullish(),
  priceDelta: z.number().optional(),
  recipeMultiplier: z.number().positive().max(20).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const productSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  barcode: z.string().trim().max(64).nullish(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  categoryId: z.string().uuid(),
  imageUrl: z.string().url().max(500).nullish().or(z.literal('')),
  basePrice: z.number().min(0),
  baseCost: z.number().min(0).optional(),
  taxRate: z.number().min(0).max(1).optional(),
  isActive: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  trackRecipe: z.boolean().optional(),
  preparingSec: z.number().int().min(0).max(3600).optional(),
  sortOrder: z.number().int().min(0).optional(),
  recipe: z.array(recipeLineSchema).max(50).optional(),
  variants: z.array(variantSchema).max(20).optional(),
});

const productQuery = paginationSchema.extend({
  categoryId: z.string().uuid().optional(),
  isActive: booleanQuery,
  favoritesOnly: booleanQuery,
});

export const catalogRouter = Router();

// --- POS catalog ------------------------------------------------------------
catalogRouter.get('/pos', asyncHandler(async (_req, res) => ok(res, await service.posCatalog())));

catalogRouter.get(
  '/products/barcode/:code',
  asyncHandler(async (req, res) => ok(res, await service.findByBarcode(String(req.params.code)))),
);

// --- Categories -------------------------------------------------------------
catalogRouter.get(
  '/categories',
  asyncHandler(async (req, res) => ok(res, await service.listCategories(req.query.includeInactive === 'true'))),
);

catalogRouter.post(
  '/categories',
  authorize('MANAGER'),
  validateBody(categorySchema),
  audit('category.create', 'Category'),
  asyncHandler(async (req, res) => created(res, await service.createCategory(req.body))),
);

catalogRouter.patch(
  '/categories/:id',
  authorize('MANAGER'),
  validateBody(categorySchema.partial()),
  audit('category.update', 'Category'),
  asyncHandler(async (req, res) => ok(res, await service.updateCategory(idParam.parse(req.params.id), req.body))),
);

catalogRouter.delete(
  '/categories/:id',
  authorize('MANAGER'),
  audit('category.delete', 'Category'),
  asyncHandler(async (req, res) => {
    await service.deleteCategory(idParam.parse(req.params.id));
    return noContent(res);
  }),
);

// --- Products ---------------------------------------------------------------
catalogRouter.get(
  '/products',
  validateQuery(productQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof productQuery>;
    const { items, total } = await service.listProducts({ ...query, ...skipTake(query) });
    return paginated(res, items, buildPageMeta(total, query.page, query.pageSize));
  }),
);

catalogRouter.get(
  '/products/:id',
  asyncHandler(async (req, res) => ok(res, await service.getProduct(idParam.parse(req.params.id)))),
);

catalogRouter.post(
  '/products',
  authorize('MANAGER'),
  validateBody(productSchema),
  audit('product.create', 'Product'),
  asyncHandler(async (req, res) => created(res, await service.createProduct(req.body))),
);

catalogRouter.patch(
  '/products/:id',
  authorize('MANAGER'),
  validateBody(productSchema.partial()),
  audit('product.update', 'Product'),
  asyncHandler(async (req, res) => ok(res, await service.updateProduct(idParam.parse(req.params.id), req.body))),
);

catalogRouter.delete(
  '/products/:id',
  authorize('MANAGER'),
  audit('product.archive', 'Product'),
  asyncHandler(async (req, res) => {
    await service.archiveProduct(idParam.parse(req.params.id));
    return noContent(res);
  }),
);
