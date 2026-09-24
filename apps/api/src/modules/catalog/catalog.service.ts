import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../core/errors';
import { money } from '../../core/money';
import { prisma } from '../../infra/prisma';

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);

// --------------------------------------------------------------------------
// Categories
// --------------------------------------------------------------------------

export async function listCategories(includeInactive = false) {
  return prisma.category.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { products: { where: { deletedAt: null } } } } },
  });
}

export async function createCategory(data: { name: string; color?: string; icon?: string; sortOrder?: number }) {
  return prisma.category.create({ data: { ...data, slug: slugify(data.name) } });
}

export async function updateCategory(id: string, data: Prisma.CategoryUpdateInput & { name?: string }) {
  const payload = { ...data, ...(data.name ? { slug: slugify(String(data.name)) } : {}) };
  return prisma.category.update({ where: { id }, data: payload });
}

export async function deleteCategory(id: string) {
  const productCount = await prisma.product.count({ where: { categoryId: id, deletedAt: null } });
  if (productCount > 0) {
    throw new ConflictError(`Cannot delete a category that still has ${productCount} product(s). Move or archive them first.`);
  }
  await prisma.category.delete({ where: { id } });
}

// --------------------------------------------------------------------------
// Products
// --------------------------------------------------------------------------

const productInclude = {
  category: { select: { id: true, name: true, color: true } },
  variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
  recipe: { include: { ingredient: { select: { id: true, name: true, unit: true, costPerUnit: true } } } },
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** Recipe cost per single unit — the COGS basis snapshotted onto each sale. */
export function computeRecipeCost(product: ProductWithRelations): Prisma.Decimal {
  if (!product.trackRecipe || product.recipe.length === 0) return money(product.baseCost);
  return money(
    product.recipe.reduce<Prisma.Decimal>(
      (acc, line) => acc.plus(line.quantity.times(line.ingredient.costPerUnit)),
      new Prisma.Decimal(0),
    ),
  );
}

const decorate = (product: ProductWithRelations) => {
  const cost = computeRecipeCost(product);
  const margin = money(product.basePrice.minus(cost));
  return {
    ...product,
    costPrice: cost,
    marginAmount: margin,
    marginPercent: product.basePrice.greaterThan(0)
      ? Number(margin.dividedBy(product.basePrice).times(100).toFixed(2))
      : 0,
  };
};

export async function listProducts(filters: {
  search?: string;
  categoryId?: string;
  isActive?: boolean;
  favoritesOnly?: boolean;
  skip: number;
  take: number;
}) {
  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.favoritesOnly ? { isFavorite: true } : {}),
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: 'insensitive' } },
            { sku: { contains: filters.search, mode: 'insensitive' } },
            { barcode: { equals: filters.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      skip: filters.skip,
      take: filters.take,
    }),
    prisma.product.count({ where }),
  ]);

  return { items: items.map(decorate), total };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null }, include: productInclude });
  if (!product) throw new NotFoundError('Product');
  return decorate(product);
}

/** Barcode scanner entry point for the POS. */
export async function findByBarcode(code: string) {
  const product = await prisma.product.findFirst({
    where: { deletedAt: null, isActive: true, OR: [{ barcode: code }, { sku: code }, { variants: { some: { sku: code } } }] },
    include: productInclude,
  });
  if (!product) throw new NotFoundError('Product for this barcode');
  return decorate(product);
}

export interface RecipeLineInput {
  ingredientId: string;
  quantity: number;
  isOptional?: boolean;
}

export interface VariantInput {
  id?: string;
  name: string;
  sku?: string | null;
  priceDelta?: number;
  recipeMultiplier?: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export interface ProductInput {
  sku: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  categoryId: string;
  imageUrl?: string | null;
  basePrice: number;
  baseCost?: number;
  taxRate?: number;
  isActive?: boolean;
  isFavorite?: boolean;
  trackRecipe?: boolean;
  preparingSec?: number;
  sortOrder?: number;
  recipe?: RecipeLineInput[];
  variants?: VariantInput[];
}

export async function createProduct(input: ProductInput) {
  const { recipe = [], variants = [], ...data } = input;

  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({ data });

    if (recipe.length > 0) {
      await tx.recipeItem.createMany({
        data: recipe.map((line) => ({
          productId: created.id,
          ingredientId: line.ingredientId,
          quantity: new Prisma.Decimal(line.quantity),
          isOptional: line.isOptional ?? false,
        })),
      });
    }

    if (variants.length > 0) {
      await tx.productVariant.createMany({
        data: variants.map((variant, index) => ({
          productId: created.id,
          name: variant.name,
          sku: variant.sku || null,
          priceDelta: new Prisma.Decimal(variant.priceDelta ?? 0),
          recipeMultiplier: new Prisma.Decimal(variant.recipeMultiplier ?? 1),
          isDefault: variant.isDefault ?? index === 0,
          sortOrder: variant.sortOrder ?? index,
        })),
      });
    }

    return created;
  });

  return getProduct(product.id);
}

export async function updateProduct(id: string, input: Partial<ProductInput>) {
  const { recipe, variants, ...data } = input;

  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id }, data });

    // Recipes and variants are replaced wholesale — simpler and always consistent.
    if (recipe) {
      await tx.recipeItem.deleteMany({ where: { productId: id } });
      if (recipe.length > 0) {
        await tx.recipeItem.createMany({
          data: recipe.map((line) => ({
            productId: id,
            ingredientId: line.ingredientId,
            quantity: new Prisma.Decimal(line.quantity),
            isOptional: line.isOptional ?? false,
          })),
        });
      }
    }

    if (variants) {
      const keepIds = variants.map((v) => v.id).filter(Boolean) as string[];
      await tx.productVariant.updateMany({
        where: { productId: id, id: { notIn: keepIds.length > 0 ? keepIds : ['__none__'] } },
        data: { isActive: false },
      });
      for (const [index, variant] of variants.entries()) {
        const payload = {
          name: variant.name,
          sku: variant.sku || null,
          priceDelta: new Prisma.Decimal(variant.priceDelta ?? 0),
          recipeMultiplier: new Prisma.Decimal(variant.recipeMultiplier ?? 1),
          isDefault: variant.isDefault ?? index === 0,
          sortOrder: variant.sortOrder ?? index,
          isActive: true,
        };
        if (variant.id) {
          await tx.productVariant.update({ where: { id: variant.id }, data: payload });
        } else {
          await tx.productVariant.create({ data: { ...payload, productId: id } });
        }
      }
    }
  });

  return getProduct(id);
}

/** Soft delete keeps historical order lines and reports intact. */
export async function archiveProduct(id: string) {
  await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
}

/** POS catalog payload: everything a terminal needs, cacheable for offline use. */
export async function posCatalog() {
  const [categories, products] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.product.findMany({
      where: { deletedAt: null, isActive: true },
      include: productInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  return {
    categories,
    products: products.map((product) => {
      const decorated = decorate(product);
      return {
        id: decorated.id,
        sku: decorated.sku,
        barcode: decorated.barcode,
        name: decorated.name,
        description: decorated.description,
        categoryId: decorated.categoryId,
        categoryName: decorated.category.name,
        imageUrl: decorated.imageUrl,
        basePrice: decorated.basePrice,
        taxRate: decorated.taxRate,
        isFavorite: decorated.isFavorite,
        costPrice: decorated.costPrice,
        variants: decorated.variants.map((v) => ({
          id: v.id,
          name: v.name,
          priceDelta: v.priceDelta,
          recipeMultiplier: v.recipeMultiplier,
          isDefault: v.isDefault,
        })),
      };
    }),
    syncedAt: new Date().toISOString(),
  };
}
