import { Prisma, StockMovementType, type UnitType } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../core/errors';
import { prisma } from '../../infra/prisma';
import { applyMovement } from './inventory.service';

export interface IngredientInput {
  sku: string;
  name: string;
  unit: UnitType;
  costPerUnit?: number;
  lowStockAt?: number;
  reorderQty?: number;
  supplierId?: string | null;
  isActive?: boolean;
  /** Seeds the opening balance for the current branch on creation. */
  openingStock?: number;
}

const include = {
  supplier: { select: { id: true, name: true } },
  _count: { select: { recipeIn: true } },
} satisfies Prisma.IngredientInclude;

export async function listIngredients(filters: { search?: string; supplierId?: string; isActive?: boolean; skip: number; take: number }) {
  const where: Prisma.IngredientWhereInput = {
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: 'insensitive' } },
            { sku: { contains: filters.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.ingredient.findMany({ where, include, orderBy: { name: 'asc' }, skip: filters.skip, take: filters.take }),
    prisma.ingredient.count({ where }),
  ]);

  return { items, total };
}

export async function getIngredient(id: string) {
  const ingredient = await prisma.ingredient.findUnique({
    where: { id },
    include: { ...include, stocks: { include: { branch: { select: { id: true, name: true, code: true } } } } },
  });
  if (!ingredient) throw new NotFoundError('Ingredient');
  return ingredient;
}

export async function createIngredient(branchId: string, userId: string, input: IngredientInput) {
  const { openingStock = 0, ...data } = input;

  return prisma.$transaction(async (tx) => {
    const ingredient = await tx.ingredient.create({
      data: {
        ...data,
        costPerUnit: new Prisma.Decimal(data.costPerUnit ?? 0),
        lowStockAt: new Prisma.Decimal(data.lowStockAt ?? 0),
        reorderQty: new Prisma.Decimal(data.reorderQty ?? 0),
      },
    });

    // Every branch gets a stock row so joins and reports never miss an item.
    const branches = await tx.branch.findMany({ where: { isActive: true }, select: { id: true } });
    await tx.inventoryStock.createMany({
      data: branches.map((b) => ({ branchId: b.id, ingredientId: ingredient.id, quantity: 0 })),
      skipDuplicates: true,
    });

    if (openingStock > 0) {
      await applyMovement(tx, {
        branchId,
        ingredientId: ingredient.id,
        type: StockMovementType.OPENING,
        quantity: openingStock,
        unitCost: data.costPerUnit ?? 0,
        referenceType: 'OPENING_BALANCE',
        note: 'Opening balance',
        userId,
      });
    }

    return ingredient;
  });
}

export async function updateIngredient(id: string, input: Partial<IngredientInput>) {
  const { openingStock: _ignored, ...data } = input;
  return prisma.ingredient.update({
    where: { id },
    data: {
      ...data,
      ...(data.costPerUnit != null ? { costPerUnit: new Prisma.Decimal(data.costPerUnit) } : {}),
      ...(data.lowStockAt != null ? { lowStockAt: new Prisma.Decimal(data.lowStockAt) } : {}),
      ...(data.reorderQty != null ? { reorderQty: new Prisma.Decimal(data.reorderQty) } : {}),
    },
    include,
  });
}

export async function archiveIngredient(id: string) {
  const usedBy = await prisma.recipeItem.count({ where: { ingredientId: id, product: { deletedAt: null, isActive: true } } });
  if (usedBy > 0) {
    throw new ConflictError(`This ingredient is still used by ${usedBy} active recipe(s). Remove it from them first.`);
  }
  return prisma.ingredient.update({ where: { id }, data: { isActive: false } });
}

// --------------------------------------------------------------------------
// Suppliers
// --------------------------------------------------------------------------

export async function listSuppliers(search?: string) {
  return prisma.supplier.findMany({
    where: {
      isActive: true,
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    },
    include: { _count: { select: { ingredients: true, purchaseOrders: true } } },
    orderBy: { name: 'asc' },
  });
}

export const createSupplier = (data: Prisma.SupplierCreateInput) => prisma.supplier.create({ data });

export const updateSupplier = (id: string, data: Prisma.SupplierUpdateInput) =>
  prisma.supplier.update({ where: { id }, data });

export const archiveSupplier = (id: string) => prisma.supplier.update({ where: { id }, data: { isActive: false } });
