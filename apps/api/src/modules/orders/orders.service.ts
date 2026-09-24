import { OrderStatus, PaymentStatus, Prisma, StockMovementType } from '@prisma/client';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors';
import { money, roundToNearest, sum } from '../../core/money';
import { logger } from '../../core/logger';
import { prisma, type DbClient } from '../../infra/prisma';
import { RealtimeEvent, emitToBranch } from '../../infra/realtime';
import * as inventory from '../inventory/inventory.service';
import { getSettings } from '../settings/settings.service';
import type { CreateOrderInput, OrderQuery, QuoteOrderInput } from './orders.schema';

export const orderInclude = {
  items: {
    include: {
      product: { select: { id: true, name: true, sku: true, imageUrl: true } },
      variant: { select: { id: true, name: true } },
    },
  },
  payments: true,
  customer: { select: { id: true, code: true, name: true, phone: true, loyaltyPoints: true } },
  cashier: { select: { id: true, fullName: true, employeeCode: true } },
  branch: { select: { id: true, name: true, code: true, address: true, phone: true } },
} satisfies Prisma.OrderInclude;

/**
 * Daily, per-branch sequence: INV/BR01/20260901/0042.
 * Collisions under concurrency are handled by the retry loop in `createOrder`.
 */
async function nextOrderNumber(db: DbClient, branchId: string, prefix: string): Promise<string> {
  const branch = await db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { code: true } });
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);

  const count = await db.order.count({ where: { branchId, createdAt: { gte: startOfDay, lt: endOfDay } } });
  const datePart = `${startOfDay.getFullYear()}${String(startOfDay.getMonth() + 1).padStart(2, '0')}${String(startOfDay.getDate()).padStart(2, '0')}`;

  return `${prefix}/${branch.code}/${datePart}/${String(count + 1).padStart(4, '0')}`;
}

interface PricedLine {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  note: string | null;
  demands: inventory.IngredientDemand[];
}

type PriceableOrder = Pick<CreateOrderInput, 'items' | 'discountType' | 'discountValue'>;

/**
 * Prices every line and resolves its ingredient demand.
 * Pure calculation — no writes — so it can also back a "quote" endpoint.
 */
async function priceOrder(db: DbClient, input: PriceableOrder) {
  const settings = await getSettings();
  const productIds = [...new Set(input.items.map((i) => i.productId))];

  const products = await db.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    include: {
      variants: true,
      recipe: { include: { ingredient: { select: { id: true, costPerUnit: true } } } },
    },
  });

  const productMap = new Map(products.map((p) => [p.id, p]));
  const missing = productIds.filter((id) => !productMap.has(id));
  if (missing.length > 0) throw new NotFoundError(`Product(s) ${missing.join(', ')}`);

  const inactive = products.filter((p) => !p.isActive).map((p) => p.name);
  if (inactive.length > 0) throw new BadRequestError(`These products are no longer available: ${inactive.join(', ')}`);

  const lines: PricedLine[] = [];

  for (const item of input.items) {
    const product = productMap.get(item.productId)!;
    const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
    if (item.variantId && !variant) throw new NotFoundError('Product variant');

    const multiplier = variant?.recipeMultiplier ?? new Prisma.Decimal(1);
    const unitPrice = money(product.basePrice.plus(variant?.priceDelta ?? 0));

    const unitCost = product.trackRecipe && product.recipe.length > 0
      ? money(
          product.recipe
            .reduce<Prisma.Decimal>((acc, r) => acc.plus(r.quantity.times(r.ingredient.costPerUnit)), new Prisma.Decimal(0))
            .times(multiplier),
        )
      : money(product.baseCost);

    const gross = unitPrice.times(item.quantity);
    const discountAmount = money(Math.min(item.discountAmount, gross.toNumber()));
    const net = money(gross.minus(discountAmount));

    const effectiveTaxRate = settings.taxEnabled
      ? product.taxRate.greaterThan(0)
        ? product.taxRate
        : new Prisma.Decimal(settings.taxRate)
      : new Prisma.Decimal(0);

    // Tax-inclusive pricing extracts the tax already baked into the price.
    const taxAmount = settings.taxInclusive
      ? money(net.minus(net.dividedBy(effectiveTaxRate.plus(1))))
      : money(net.times(effectiveTaxRate));

    lines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      productName: product.name,
      variantName: variant?.name ?? null,
      quantity: item.quantity,
      unitPrice,
      unitCost,
      discountAmount,
      taxAmount,
      lineTotal: net,
      note: item.note ?? null,
      demands:
        product.trackRecipe
          ? product.recipe.map((r) => ({
              ingredientId: r.ingredientId,
              quantity: r.quantity.times(multiplier).times(item.quantity),
            }))
          : [],
    });
  }

  const subtotal = money(sum(lines.map((l) => l.unitPrice.times(l.quantity))));
  const lineDiscounts = money(sum(lines.map((l) => l.discountAmount)));
  const netAfterLines = money(subtotal.minus(lineDiscounts));

  let orderDiscount = new Prisma.Decimal(0);
  if (input.discountType === 'PERCENTAGE') {
    orderDiscount = money(netAfterLines.times(new Prisma.Decimal(input.discountValue ?? 0).dividedBy(100)));
  } else if (input.discountType === 'FIXED') {
    orderDiscount = money(Math.min(input.discountValue ?? 0, netAfterLines.toNumber()));
  }

  const discountAmount = money(lineDiscounts.plus(orderDiscount));
  const taxable = money(netAfterLines.minus(orderDiscount));
  const taxAmount = settings.taxInclusive
    ? money(sum(lines.map((l) => l.taxAmount)))
    : money(taxable.times(settings.taxEnabled ? settings.taxRate : 0));
  const serviceAmount = settings.serviceChargeEnabled ? money(taxable.times(settings.serviceChargeRate)) : new Prisma.Decimal(0);

  const rawTotal = settings.taxInclusive
    ? money(taxable.plus(serviceAmount))
    : money(taxable.plus(taxAmount).plus(serviceAmount));

  const total = roundToNearest(rawTotal, settings.cashRounding);
  const roundingAmount = money(total.minus(rawTotal));
  const costTotal = money(sum(lines.map((l) => l.unitCost.times(l.quantity))));

  return { lines, subtotal, discountAmount, taxAmount, serviceAmount, roundingAmount, total, costTotal, settings };
}

/** Dry-run pricing for the POS cart — no persistence, no stock movement. */
export async function quote(input: QuoteOrderInput) {
  const priced = await priceOrder(prisma, input);
  return {
    subtotal: priced.subtotal,
    discountAmount: priced.discountAmount,
    taxAmount: priced.taxAmount,
    serviceAmount: priced.serviceAmount,
    roundingAmount: priced.roundingAmount,
    total: priced.total,
    costTotal: priced.costTotal,
    estimatedProfit: money(priced.total.minus(priced.taxAmount).minus(priced.costTotal)),
    lines: priced.lines.map(({ demands, ...line }) => line),
  };
}

export interface CreateOrderContext {
  branchId: string;
  cashierId: string;
}

export async function createOrder(input: CreateOrderInput, ctx: CreateOrderContext) {
  // Offline replay guard: return the original order instead of duplicating it.
  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: orderInclude });
    if (existing) return { order: existing, duplicate: true };
  }

  const priced = await priceOrder(prisma, input);

  const paidAmount = money(sum(input.payments.map((p) => p.amount)));
  if (paidAmount.lessThan(priced.total)) {
    throw new BadRequestError(
      `Payment of ${paidAmount.toFixed(2)} is less than the order total of ${priced.total.toFixed(2)}`,
    );
  }

  const nonCash = input.payments.filter((p) => p.method !== 'CASH');
  const nonCashTotal = money(sum(nonCash.map((p) => p.amount)));
  if (nonCashTotal.greaterThan(priced.total)) {
    throw new BadRequestError('Non-cash payments cannot exceed the order total');
  }
  // Change is only ever returned against the cash tendered.
  const changeAmount = money(Prisma.Decimal.max(paidAmount.minus(priced.total), 0));

  const demands = inventory.aggregateDemands(priced.lines.flatMap((l) => l.demands));
  const activeShift = await prisma.shift.findFirst({
    where: { branchId: ctx.branchId, userId: ctx.cashierId, status: 'OPEN' },
    select: { id: true },
  });

  const run = async () =>
    prisma.$transaction(
      async (tx) => {
        const orderNumber = await nextOrderNumber(tx, ctx.branchId, priced.settings.orderPrefix);

        const order = await tx.order.create({
          data: {
            orderNumber,
            idempotencyKey: input.idempotencyKey ?? null,
            branchId: ctx.branchId,
            cashierId: ctx.cashierId,
            customerId: input.customerId ?? null,
            shiftId: activeShift?.id ?? null,
            status: OrderStatus.COMPLETED,
            channel: input.channel,
            tableNumber: input.tableNumber ?? null,
            subtotal: priced.subtotal,
            discountAmount: priced.discountAmount,
            taxAmount: priced.taxAmount,
            serviceAmount: priced.serviceAmount,
            roundingAmount: priced.roundingAmount,
            total: priced.total,
            paidAmount,
            changeAmount,
            costTotal: priced.costTotal,
            discountType: input.discountType ?? null,
            discountValue: input.discountValue != null ? new Prisma.Decimal(input.discountValue) : null,
            note: input.note ?? null,
            completedAt: new Date(),
            clientCreatedAt: input.clientCreatedAt ?? null,
            items: {
              create: priced.lines.map((line) => ({
                productId: line.productId,
                variantId: line.variantId,
                productName: line.productName,
                variantName: line.variantName,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                unitCost: line.unitCost,
                discountAmount: line.discountAmount,
                taxAmount: line.taxAmount,
                lineTotal: line.lineTotal,
                note: line.note,
              })),
            },
            payments: {
              create: input.payments.map((payment) => ({
                method: payment.method,
                status: PaymentStatus.PAID,
                amount: money(payment.amount),
                feeAmount: money(
                  new Prisma.Decimal(payment.amount).times(priced.settings.paymentFees[payment.method] ?? 0),
                ),
                referenceNo: payment.referenceNo ?? null,
              })),
            },
          },
          include: orderInclude,
        });

        // Ingredients leave stock in the same transaction as the sale — the two
        // can never drift apart, even if the process dies mid-request.
        await inventory.consume(tx, {
          branchId: ctx.branchId,
          demands,
          referenceType: 'ORDER',
          referenceId: order.id,
          userId: ctx.cashierId,
        });

        if (input.customerId) {
          const points = priced.settings.loyaltyEnabled && priced.settings.loyaltyEarnRate > 0
            ? Math.floor(priced.total.dividedBy(priced.settings.loyaltyEarnRate).toNumber())
            : 0;
          await tx.customer.update({
            where: { id: input.customerId },
            data: {
              totalSpent: { increment: priced.total },
              visitCount: { increment: 1 },
              loyaltyPoints: { increment: points },
              lastVisitAt: new Date(),
            },
          });
        }

        return order;
      },
      { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

  let order: Awaited<ReturnType<typeof run>>;
  try {
    order = await run();
  } catch (err) {
    // A concurrent sale grabbed the same sequence number — retry once.
    const isDuplicateNumber =
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      (err.meta?.target as string[] | undefined)?.includes('orderNumber');
    if (!isDuplicateNumber) throw err;
    logger.warn('Order number collision detected, retrying');
    order = await run();
  }

  emitToBranch(ctx.branchId, RealtimeEvent.OrderCreated, {
    id: order.id,
    orderNumber: order.orderNumber,
    total: order.total.toNumber(),
    itemCount: order.items.length,
    cashier: order.cashier.fullName,
    createdAt: order.createdAt,
  });

  if (demands.length > 0) {
    emitToBranch(ctx.branchId, RealtimeEvent.StockChanged, { ingredientIds: demands.map((d) => d.ingredientId) });
    void inventory.evaluateLowStock(ctx.branchId, demands.map((d) => d.ingredientId));
  }

  return { order, duplicate: false };
}

export async function listOrders(branchId: string, query: OrderQuery) {
  const where: Prisma.OrderWhereInput = {
    branchId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.cashierId ? { cashierId: query.cashierId } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.method ? { payments: { some: { method: query.method } } } : {}),
    ...(query.from || query.to
      ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
      : {}),
    ...(query.search
      ? {
          OR: [
            { orderNumber: { contains: query.search, mode: 'insensitive' } },
            { customer: { name: { contains: query.search, mode: 'insensitive' } } },
            { items: { some: { productName: { contains: query.search, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [items, total, aggregate] = await Promise.all([
    prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
    prisma.order.aggregate({ where: { ...where, status: OrderStatus.COMPLETED }, _sum: { total: true, costTotal: true } }),
  ]);

  return {
    items,
    total,
    summary: {
      revenue: aggregate._sum.total ?? new Prisma.Decimal(0),
      cost: aggregate._sum.costTotal ?? new Prisma.Decimal(0),
    },
  };
}

export async function getOrder(branchId: string, id: string) {
  const order = await prisma.order.findFirst({ where: { id, branchId }, include: orderInclude });
  if (!order) throw new NotFoundError('Order');
  return order;
}

/** Receipt payload — everything the printer template needs in one call. */
export async function getReceipt(branchId: string, id: string) {
  const [order, settings] = await Promise.all([getOrder(branchId, id), getSettings()]);
  return {
    order,
    store: {
      name: settings.storeName || order.branch.name,
      address: settings.storeAddress || order.branch.address,
      phone: settings.storePhone || order.branch.phone,
      footer: settings.receiptFooter,
      logoUrl: settings.receiptLogoUrl,
      currency: settings.currency,
      locale: settings.locale,
      taxInclusive: settings.taxInclusive,
    },
  };
}

async function reverseOrder(
  branchId: string,
  id: string,
  userId: string,
  status: 'VOIDED' | 'REFUNDED',
  reason: string,
  restock: boolean,
) {
  const order = await getOrder(branchId, id);
  if (order.status !== OrderStatus.COMPLETED) {
    throw new ConflictError(`Only completed orders can be ${status === 'VOIDED' ? 'voided' : 'refunded'}`);
  }

  const movements = await prisma.stockMovement.findMany({
    where: { referenceType: 'ORDER', referenceId: id, type: StockMovementType.SALE },
    select: { ingredientId: true, quantity: true },
  });

  const updated = await prisma.$transaction(async (tx) => {
    if (restock && movements.length > 0) {
      // Movements were negative on sale — negate them to put stock back.
      await inventory.restore(tx, {
        branchId,
        demands: movements.map((m) => ({ ingredientId: m.ingredientId, quantity: m.quantity.negated() })),
        referenceType: 'ORDER',
        referenceId: id,
        userId,
      });
    }

    if (order.customerId) {
      await tx.customer.update({
        where: { id: order.customerId },
        data: { totalSpent: { decrement: order.total }, visitCount: { decrement: 1 } },
      });
    }

    await tx.payment.updateMany({ where: { orderId: id }, data: { status: PaymentStatus.REFUNDED } });

    return tx.order.update({
      where: { id },
      data: { status, voidReason: reason, voidedAt: new Date() },
      include: orderInclude,
    });
  });

  emitToBranch(branchId, RealtimeEvent.OrderVoided, { id, orderNumber: order.orderNumber, status });
  if (restock && movements.length > 0) {
    emitToBranch(branchId, RealtimeEvent.StockChanged, { ingredientIds: movements.map((m) => m.ingredientId) });
  }

  return updated;
}

export const voidOrder = (branchId: string, id: string, userId: string, reason: string, restock: boolean) =>
  reverseOrder(branchId, id, userId, OrderStatus.VOIDED, reason, restock);

export const refundOrder = (branchId: string, id: string, userId: string, reason: string, restock: boolean) =>
  reverseOrder(branchId, id, userId, OrderStatus.REFUNDED, reason, restock);
