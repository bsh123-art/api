import { Prisma, PurchaseOrderStatus, StockMovementType } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../core/errors';
import { money, qty as toQty, sum } from '../../core/money';
import { prisma } from '../../infra/prisma';
import { RealtimeEvent, emitToBranch } from '../../infra/realtime';
import * as inventory from '../inventory/inventory.service';

const poInclude = {
  supplier: { select: { id: true, name: true, phone: true, email: true } },
  items: { include: { ingredient: { select: { id: true, name: true, unit: true, costPerUnit: true } } } },
  createdBy: { select: { id: true, fullName: true } },
  branch: { select: { id: true, name: true, code: true } },
} satisfies Prisma.PurchaseOrderInclude;

async function nextPoNumber(db: Prisma.TransactionClient, branchId: string): Promise<string> {
  const branch = await db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { code: true } });
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const count = await db.purchaseOrder.count({ where: { branchId, createdAt: { gte: monthStart } } });
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `PO/${branch.code}/${stamp}/${String(count + 1).padStart(3, '0')}`;
}

export interface PurchaseOrderItemInput {
  ingredientId: string;
  quantity: number;
  unitCost: number;
}

export interface PurchaseOrderInput {
  supplierId: string;
  expectedAt?: Date | null;
  shippingFee?: number;
  taxAmount?: number;
  note?: string | null;
  items: PurchaseOrderItemInput[];
}

const priceItems = (items: PurchaseOrderItemInput[], shippingFee = 0, taxAmount = 0) => {
  const lines = items.map((item) => ({
    ingredientId: item.ingredientId,
    quantity: toQty(item.quantity),
    unitCost: new Prisma.Decimal(item.unitCost),
    lineTotal: money(new Prisma.Decimal(item.quantity).times(item.unitCost)),
  }));
  const subtotal = money(sum(lines.map((l) => l.lineTotal)));
  return { lines, subtotal, total: money(subtotal.plus(shippingFee).plus(taxAmount)) };
};

export async function createPurchaseOrder(branchId: string, userId: string, input: PurchaseOrderInput) {
  const { lines, subtotal, total } = priceItems(input.items, input.shippingFee, input.taxAmount);

  return prisma.$transaction(async (tx) => {
    const poNumber = await nextPoNumber(tx, branchId);
    return tx.purchaseOrder.create({
      data: {
        poNumber,
        branchId,
        supplierId: input.supplierId,
        createdById: userId,
        expectedAt: input.expectedAt ?? null,
        shippingFee: money(input.shippingFee ?? 0),
        taxAmount: money(input.taxAmount ?? 0),
        subtotal,
        total,
        note: input.note ?? null,
        items: { create: lines },
      },
      include: poInclude,
    });
  });
}

export async function updatePurchaseOrder(branchId: string, id: string, input: PurchaseOrderInput) {
  const existing = await prisma.purchaseOrder.findFirst({ where: { id, branchId } });
  if (!existing) throw new NotFoundError('Purchase order');
  if (existing.status !== PurchaseOrderStatus.DRAFT) {
    throw new ConflictError('Only draft purchase orders can be edited');
  }

  const { lines, subtotal, total } = priceItems(input.items, input.shippingFee, input.taxAmount);

  return prisma.$transaction(async (tx) => {
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    return tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        expectedAt: input.expectedAt ?? null,
        shippingFee: money(input.shippingFee ?? 0),
        taxAmount: money(input.taxAmount ?? 0),
        subtotal,
        total,
        note: input.note ?? null,
        items: { create: lines },
      },
      include: poInclude,
    });
  });
}

export async function submitPurchaseOrder(branchId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, branchId } });
  if (!po) throw new NotFoundError('Purchase order');
  if (po.status !== PurchaseOrderStatus.DRAFT) throw new ConflictError('This purchase order has already been submitted');

  return prisma.purchaseOrder.update({
    where: { id },
    data: { status: PurchaseOrderStatus.ORDERED, orderedAt: new Date() },
    include: poInclude,
  });
}

export interface ReceiptLine {
  itemId: string;
  receivedQty: number;
  /** Overrides the ordered price when the supplier invoiced differently. */
  actualUnitCost?: number;
}

/**
 * Goods receipt: adds stock and rolls the ingredient's weighted-average cost
 * forward, which keeps COGS on future sales accurate.
 */
export async function receivePurchaseOrder(
  branchId: string,
  id: string,
  userId: string,
  receipts: ReceiptLine[],
  note?: string,
) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, branchId }, include: poInclude });
  if (!po) throw new NotFoundError('Purchase order');
  if (po.status === PurchaseOrderStatus.RECEIVED) throw new ConflictError('This purchase order is already fully received');
  if (po.status === PurchaseOrderStatus.CANCELLED) throw new ConflictError('Cannot receive a cancelled purchase order');

  const itemMap = new Map(po.items.map((i) => [i.id, i]));

  const updated = await prisma.$transaction(async (tx) => {
    for (const receipt of receipts) {
      const item = itemMap.get(receipt.itemId);
      if (!item) throw new NotFoundError(`Purchase order line ${receipt.itemId}`);

      const incoming = toQty(receipt.receivedQty);
      if (incoming.lessThanOrEqualTo(0)) continue;

      const outstanding = item.quantity.minus(item.receivedQty);
      if (incoming.greaterThan(outstanding)) {
        throw new ConflictError(
          `Cannot receive ${incoming.toNumber()} of ${item.ingredient.name} — only ${outstanding.toNumber()} remain outstanding`,
        );
      }

      const unitCost = new Prisma.Decimal(receipt.actualUnitCost ?? item.unitCost);

      const stock = await tx.inventoryStock.findUnique({
        where: { branchId_ingredientId: { branchId, ingredientId: item.ingredientId } },
        select: { quantity: true },
      });
      const onHand = stock?.quantity ?? new Prisma.Decimal(0);

      await inventory.applyMovement(tx, {
        branchId,
        ingredientId: item.ingredientId,
        type: StockMovementType.PURCHASE,
        quantity: incoming,
        unitCost,
        referenceType: 'PURCHASE_ORDER',
        referenceId: po.id,
        note: note ?? `Received against ${po.poNumber}`,
        userId,
      });

      // Weighted average: (existing value + incoming value) / total quantity.
      const totalQty = onHand.plus(incoming);
      if (totalQty.greaterThan(0)) {
        const newCost = onHand
          .times(item.ingredient.costPerUnit)
          .plus(incoming.times(unitCost))
          .dividedBy(totalQty)
          .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
        await tx.ingredient.update({ where: { id: item.ingredientId }, data: { costPerUnit: newCost } });
      }

      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { receivedQty: { increment: incoming }, unitCost },
      });
    }

    const refreshed = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
    const fullyReceived = refreshed.every((i) => i.receivedQty.greaterThanOrEqualTo(i.quantity));
    const partially = refreshed.some((i) => i.receivedQty.greaterThan(0));

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        status: fullyReceived
          ? PurchaseOrderStatus.RECEIVED
          : partially
            ? PurchaseOrderStatus.PARTIALLY_RECEIVED
            : po.status,
        receivedAt: fullyReceived ? new Date() : po.receivedAt,
      },
      include: poInclude,
    });
  });

  emitToBranch(branchId, RealtimeEvent.StockChanged, { purchaseOrderId: id });
  void inventory.evaluateLowStock(branchId, po.items.map((i) => i.ingredientId));

  return updated;
}

export async function cancelPurchaseOrder(branchId: string, id: string, reason?: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, branchId } });
  if (!po) throw new NotFoundError('Purchase order');
  if (po.status === PurchaseOrderStatus.RECEIVED) throw new ConflictError('A fully received purchase order cannot be cancelled');

  return prisma.purchaseOrder.update({
    where: { id },
    data: { status: PurchaseOrderStatus.CANCELLED, note: reason ? `${po.note ?? ''}\nCancelled: ${reason}`.trim() : po.note },
    include: poInclude,
  });
}

export async function listPurchaseOrders(branchId: string, filters: {
  status?: PurchaseOrderStatus;
  supplierId?: string;
  search?: string;
  skip: number;
  take: number;
}) {
  const where: Prisma.PurchaseOrderWhereInput = {
    branchId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.search
      ? {
          OR: [
            { poNumber: { contains: filters.search, mode: 'insensitive' } },
            { supplier: { name: { contains: filters.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, include: poInclude, orderBy: { createdAt: 'desc' }, skip: filters.skip, take: filters.take }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return { items, total };
}

export async function getPurchaseOrder(branchId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, branchId }, include: poInclude });
  if (!po) throw new NotFoundError('Purchase order');
  return po;
}

/** Suggests a restock basket from every ingredient at or below its threshold. */
export async function reorderSuggestions(branchId: string) {
  const stocks = await prisma.inventoryStock.findMany({
    where: { branchId, ingredient: { isActive: true } },
    include: { ingredient: { include: { supplier: { select: { id: true, name: true } } } } },
  });

  return stocks
    .filter((s) => s.quantity.lessThanOrEqualTo(s.ingredient.lowStockAt))
    .map((s) => ({
      ingredientId: s.ingredientId,
      name: s.ingredient.name,
      unit: s.ingredient.unit,
      onHand: s.quantity,
      lowStockAt: s.ingredient.lowStockAt,
      suggestedQty: s.ingredient.reorderQty.greaterThan(0)
        ? s.ingredient.reorderQty
        : toQty(s.ingredient.lowStockAt.times(2).minus(s.quantity)),
      unitCost: s.ingredient.costPerUnit,
      supplier: s.ingredient.supplier,
    }));
}
