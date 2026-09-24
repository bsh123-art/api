import { Prisma, StockMovementType, NotificationType } from '@prisma/client';
import { InsufficientStockError, NotFoundError } from '../../core/errors';
import { qty as toQty, money } from '../../core/money';
import { logger } from '../../core/logger';
import { prisma, type DbClient } from '../../infra/prisma';
import { RealtimeEvent, emitToBranch } from '../../infra/realtime';

export interface MovementInput {
  branchId: string;
  ingredientId: string;
  type: StockMovementType;
  /** Signed quantity: negative consumes, positive replenishes. */
  quantity: Prisma.Decimal.Value;
  unitCost?: Prisma.Decimal.Value;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  userId?: string | null;
  /** Set false for stock-takes and corrections that may legitimately go negative. */
  allowNegative?: boolean;
}

/**
 * Single source of truth for every stock change: updates the balance and
 * appends an immutable ledger row in the same transaction.
 */
export async function applyMovement(db: DbClient, input: MovementInput): Promise<Prisma.Decimal> {
  const delta = toQty(input.quantity);
  if (delta.isZero()) {
    const current = await db.inventoryStock.findUnique({
      where: { branchId_ingredientId: { branchId: input.branchId, ingredientId: input.ingredientId } },
      select: { quantity: true },
    });
    return current?.quantity ?? new Prisma.Decimal(0);
  }

  const stock = await db.inventoryStock.upsert({
    where: { branchId_ingredientId: { branchId: input.branchId, ingredientId: input.ingredientId } },
    create: { branchId: input.branchId, ingredientId: input.ingredientId, quantity: 0 },
    update: {},
    select: { quantity: true },
  });

  const balanceAfter = toQty(stock.quantity.plus(delta));

  if (balanceAfter.isNegative() && !input.allowNegative) {
    const ingredient = await db.ingredient.findUnique({
      where: { id: input.ingredientId },
      select: { name: true, unit: true },
    });
    throw new InsufficientStockError([
      {
        ingredientId: input.ingredientId,
        ingredientName: ingredient?.name ?? 'Unknown ingredient',
        unit: ingredient?.unit,
        available: stock.quantity.toNumber(),
        required: delta.abs().toNumber(),
      },
    ]);
  }

  await db.inventoryStock.update({
    where: { branchId_ingredientId: { branchId: input.branchId, ingredientId: input.ingredientId } },
    data: { quantity: balanceAfter },
  });

  await db.stockMovement.create({
    data: {
      branchId: input.branchId,
      ingredientId: input.ingredientId,
      type: input.type,
      quantity: delta,
      balanceAfter,
      unitCost: input.unitCost != null ? new Prisma.Decimal(input.unitCost) : 0,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      note: input.note ?? null,
      userId: input.userId ?? null,
    },
  });

  return balanceAfter;
}

export interface IngredientDemand {
  ingredientId: string;
  quantity: Prisma.Decimal;
}

/**
 * Verifies every ingredient up-front so an order fails atomically with one
 * combined error instead of leaving a half-deducted inventory.
 */
export async function assertAvailability(db: DbClient, branchId: string, demands: IngredientDemand[]): Promise<void> {
  if (demands.length === 0) return;

  const ids = demands.map((d) => d.ingredientId);
  const [stocks, ingredients] = await Promise.all([
    db.inventoryStock.findMany({ where: { branchId, ingredientId: { in: ids } } }),
    db.ingredient.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, unit: true } }),
  ]);

  const stockMap = new Map(stocks.map((s) => [s.ingredientId, s.quantity]));
  const nameMap = new Map(ingredients.map((i) => [i.id, i]));

  const shortages = demands
    .map((d) => {
      const available = stockMap.get(d.ingredientId) ?? new Prisma.Decimal(0);
      if (available.greaterThanOrEqualTo(d.quantity)) return null;
      const meta = nameMap.get(d.ingredientId);
      return {
        ingredientId: d.ingredientId,
        ingredientName: meta?.name ?? 'Unknown ingredient',
        unit: meta?.unit ?? null,
        available: available.toNumber(),
        required: d.quantity.toNumber(),
        shortBy: d.quantity.minus(available).toNumber(),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (shortages.length > 0) throw new InsufficientStockError(shortages);
}

export interface ConsumeOptions {
  branchId: string;
  demands: IngredientDemand[];
  referenceType: string;
  referenceId: string;
  userId?: string | null;
  type?: StockMovementType;
}

/** Deducts an aggregated demand list — used when an order is completed. */
export async function consume(db: DbClient, opts: ConsumeOptions): Promise<void> {
  if (opts.demands.length === 0) return;
  await assertAvailability(db, opts.branchId, opts.demands);

  const costs = await db.ingredient.findMany({
    where: { id: { in: opts.demands.map((d) => d.ingredientId) } },
    select: { id: true, costPerUnit: true },
  });
  const costMap = new Map(costs.map((c) => [c.id, c.costPerUnit]));

  for (const demand of opts.demands) {
    await applyMovement(db, {
      branchId: opts.branchId,
      ingredientId: demand.ingredientId,
      type: opts.type ?? StockMovementType.SALE,
      quantity: demand.quantity.negated(),
      unitCost: costMap.get(demand.ingredientId) ?? 0,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      userId: opts.userId ?? null,
    });
  }
}

/** Puts ingredients back when an order is voided or refunded. */
export async function restore(db: DbClient, opts: ConsumeOptions): Promise<void> {
  for (const demand of opts.demands) {
    await applyMovement(db, {
      branchId: opts.branchId,
      ingredientId: demand.ingredientId,
      type: StockMovementType.VOID_RESTOCK,
      quantity: demand.quantity,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      userId: opts.userId ?? null,
      allowNegative: true,
    });
  }
}

/** Merges duplicate ingredient lines so each is written to the ledger once. */
export function aggregateDemands(items: IngredientDemand[]): IngredientDemand[] {
  const merged = new Map<string, Prisma.Decimal>();
  for (const item of items) {
    const current = merged.get(item.ingredientId) ?? new Prisma.Decimal(0);
    merged.set(item.ingredientId, current.plus(item.quantity));
  }
  return [...merged.entries()]
    .map(([ingredientId, quantity]) => ({ ingredientId, quantity: toQty(quantity) }))
    .filter((d) => d.quantity.greaterThan(0));
}

/**
 * Emits low/out-of-stock notifications. Runs outside the sales transaction so a
 * notification failure can never roll back a completed sale.
 */
export async function evaluateLowStock(branchId: string, ingredientIds: string[]): Promise<void> {
  if (ingredientIds.length === 0) return;
  try {
    const stocks = await prisma.inventoryStock.findMany({
      where: { branchId, ingredientId: { in: ingredientIds } },
      include: { ingredient: { select: { id: true, name: true, unit: true, lowStockAt: true, reorderQty: true } } },
    });

    const breaches = stocks.filter((s) => s.quantity.lessThanOrEqualTo(s.ingredient.lowStockAt));
    if (breaches.length === 0) return;

    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);

    for (const breach of breaches) {
      const isOut = breach.quantity.lessThanOrEqualTo(0);
      // Debounce: don't spam the same alert more than once per 6 hours.
      const recent = await prisma.notification.findFirst({
        where: {
          branchId,
          type: isOut ? NotificationType.OUT_OF_STOCK : NotificationType.LOW_STOCK,
          createdAt: { gte: since },
          metadata: { path: ['ingredientId'], equals: breach.ingredientId },
        },
        select: { id: true },
      });
      if (recent) continue;

      const notification = await prisma.notification.create({
        data: {
          branchId,
          type: isOut ? NotificationType.OUT_OF_STOCK : NotificationType.LOW_STOCK,
          severity: isOut ? 'critical' : 'warning',
          title: isOut ? `${breach.ingredient.name} is out of stock` : `${breach.ingredient.name} is running low`,
          message: isOut
            ? `${breach.ingredient.name} has reached zero. Products using it can no longer be sold.`
            : `Only ${breach.quantity.toNumber()} ${breach.ingredient.unit.toLowerCase()} of ${breach.ingredient.name} left (threshold ${breach.ingredient.lowStockAt.toNumber()}).`,
          metadata: {
            ingredientId: breach.ingredientId,
            remaining: breach.quantity.toNumber(),
            threshold: breach.ingredient.lowStockAt.toNumber(),
            suggestedOrderQty: breach.ingredient.reorderQty.toNumber(),
          },
        },
      });

      emitToBranch(branchId, RealtimeEvent.LowStock, notification);
      emitToBranch(branchId, RealtimeEvent.Notification, notification);
    }
  } catch (err) {
    logger.error({ err, branchId }, 'Low-stock evaluation failed');
  }
}

// --------------------------------------------------------------------------
// Queries & manual operations
// --------------------------------------------------------------------------

export async function listStock(branchId: string, filters: { search?: string; lowOnly?: boolean }) {
  const stocks = await prisma.inventoryStock.findMany({
    where: {
      branchId,
      ingredient: {
        isActive: true,
        ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
      },
    },
    include: { ingredient: { include: { supplier: { select: { id: true, name: true } } } } },
    orderBy: { ingredient: { name: 'asc' } },
  });

  const rows = stocks.map((s) => {
    const isOut = s.quantity.lessThanOrEqualTo(0);
    const isLow = !isOut && s.quantity.lessThanOrEqualTo(s.ingredient.lowStockAt);
    return {
      ingredientId: s.ingredientId,
      sku: s.ingredient.sku,
      name: s.ingredient.name,
      unit: s.ingredient.unit,
      quantity: s.quantity,
      lowStockAt: s.ingredient.lowStockAt,
      reorderQty: s.ingredient.reorderQty,
      costPerUnit: s.ingredient.costPerUnit,
      stockValue: money(s.quantity.times(s.ingredient.costPerUnit)),
      supplier: s.ingredient.supplier,
      status: isOut ? 'OUT_OF_STOCK' : isLow ? 'LOW' : 'HEALTHY',
      updatedAt: s.updatedAt,
    };
  });

  return filters.lowOnly ? rows.filter((r) => r.status !== 'HEALTHY') : rows;
}

export async function adjustStock(params: {
  branchId: string;
  ingredientId: string;
  quantity: number;
  type: StockMovementType;
  note?: string;
  userId: string;
}) {
  const ingredient = await prisma.ingredient.findUnique({ where: { id: params.ingredientId } });
  if (!ingredient) throw new NotFoundError('Ingredient');

  const balance = await prisma.$transaction((tx) =>
    applyMovement(tx, {
      branchId: params.branchId,
      ingredientId: params.ingredientId,
      type: params.type,
      quantity: params.quantity,
      unitCost: ingredient.costPerUnit,
      referenceType: 'MANUAL',
      note: params.note,
      userId: params.userId,
      allowNegative: params.type === StockMovementType.ADJUSTMENT,
    }),
  );

  emitToBranch(params.branchId, RealtimeEvent.StockChanged, {
    ingredientId: params.ingredientId,
    quantity: balance.toNumber(),
  });
  void evaluateLowStock(params.branchId, [params.ingredientId]);

  return { ingredientId: params.ingredientId, quantity: balance };
}

/** Sets an absolute counted quantity and records the variance. */
export async function stocktake(params: {
  branchId: string;
  counts: { ingredientId: string; countedQty: number }[];
  note?: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const results = [];
    for (const count of params.counts) {
      const current = await tx.inventoryStock.findUnique({
        where: { branchId_ingredientId: { branchId: params.branchId, ingredientId: count.ingredientId } },
        select: { quantity: true },
      });
      const difference = toQty(count.countedQty).minus(current?.quantity ?? 0);
      if (difference.isZero()) continue;

      await applyMovement(tx, {
        branchId: params.branchId,
        ingredientId: count.ingredientId,
        type: StockMovementType.ADJUSTMENT,
        quantity: difference,
        referenceType: 'STOCKTAKE',
        note: params.note ?? 'Stock count adjustment',
        userId: params.userId,
        allowNegative: true,
      });

      results.push({ ingredientId: count.ingredientId, difference: difference.toNumber(), countedQty: count.countedQty });
    }
    return results;
  });
}

export async function listMovements(branchId: string, filters: {
  ingredientId?: string;
  type?: StockMovementType;
  from?: Date;
  to?: Date;
  skip: number;
  take: number;
}) {
  const where: Prisma.StockMovementWhereInput = {
    branchId,
    ...(filters.ingredientId ? { ingredientId: filters.ingredientId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      include: {
        ingredient: { select: { id: true, name: true, unit: true } },
        user: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.take,
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, total };
}
