import { OrderStatus, Prisma } from '@prisma/client';
import { money, sum, toNumber } from '../../core/money';
import { prisma } from '../../infra/prisma';

export interface DateRange {
  from: Date;
  to: Date;
}

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
export const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export const dayRange = (date: Date): DateRange => ({ from: startOfDay(date), to: endOfDay(date) });

export const monthRange = (year: number, month: number): DateRange => ({
  from: new Date(year, month - 1, 1, 0, 0, 0, 0),
  to: new Date(year, month, 0, 23, 59, 59, 999),
});

const completedWhere = (branchId: string, range: DateRange): Prisma.OrderWhereInput => ({
  branchId,
  status: OrderStatus.COMPLETED,
  createdAt: { gte: range.from, lte: range.to },
});

/**
 * The canonical P&L for a period.
 *
 *   net revenue  = gross sales - discounts            (tax excluded: it is not income)
 *   gross profit = net revenue - COGS
 *   net profit   = gross profit - operating expenses - payment fees
 */
export async function summary(branchId: string, range: DateRange) {
  const where = completedWhere(branchId, range);

  const [orders, voided, expenses, payments, itemAgg] = await Promise.all([
    prisma.order.aggregate({
      where,
      _sum: { subtotal: true, discountAmount: true, taxAmount: true, serviceAmount: true, total: true, costTotal: true },
      _count: { _all: true },
      _avg: { total: true },
    }),
    prisma.order.count({ where: { branchId, status: { in: [OrderStatus.VOIDED, OrderStatus.REFUNDED] }, createdAt: { gte: range.from, lte: range.to } } }),
    prisma.expense.aggregate({
      where: { branchId, spentAt: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { order: where, status: 'PAID' },
      _sum: { amount: true, feeAmount: true },
      _count: { _all: true },
    }),
    prisma.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
  ]);

  const grossSales = money(orders._sum.subtotal ?? 0);
  const discounts = money(orders._sum.discountAmount ?? 0);
  const tax = money(orders._sum.taxAmount ?? 0);
  const service = money(orders._sum.serviceAmount ?? 0);
  const collected = money(orders._sum.total ?? 0);
  const cogs = money(orders._sum.costTotal ?? 0);
  const operatingExpenses = money(expenses._sum.amount ?? 0);
  const paymentFees = money(sum(payments.map((p) => p._sum.feeAmount ?? 0)));

  const netRevenue = money(grossSales.minus(discounts).plus(service));
  const grossProfit = money(netRevenue.minus(cogs));
  const netProfit = money(grossProfit.minus(operatingExpenses).minus(paymentFees));

  const pct = (numerator: Prisma.Decimal) =>
    netRevenue.greaterThan(0) ? Number(numerator.dividedBy(netRevenue).times(100).toFixed(2)) : 0;

  return {
    range: { from: range.from, to: range.to },
    orders: {
      count: orders._count._all,
      voidedCount: voided,
      itemsSold: itemAgg._sum.quantity ?? 0,
      averageTicket: money(orders._avg.total ?? 0),
    },
    revenue: { grossSales, discounts, serviceCharge: service, tax, netRevenue, collected },
    costs: { cogs, operatingExpenses, paymentFees },
    profit: {
      grossProfit,
      netProfit,
      grossMarginPercent: pct(grossProfit),
      netMarginPercent: pct(netProfit),
    },
    paymentBreakdown: payments.map((p) => ({
      method: p.method,
      count: p._count._all,
      amount: money(p._sum.amount ?? 0),
      fees: money(p._sum.feeAmount ?? 0),
    })),
  };
}

/** Daily revenue/profit series used by the dashboard chart. */
export async function salesSeries(branchId: string, range: DateRange, granularity: 'day' | 'hour' | 'month' = 'day') {
  const rows = await prisma.$queryRaw<{ bucket: Date; revenue: string; cost: string; orders: bigint }[]>(
    Prisma.sql`
      SELECT date_trunc(${granularity}, "createdAt") AS bucket,
             COALESCE(SUM("total"), 0)::text       AS revenue,
             COALESCE(SUM("costTotal"), 0)::text   AS cost,
             COUNT(*)                              AS orders
      FROM "orders"
      WHERE "branchId" = ${branchId}
        AND "status" = 'COMPLETED'
        AND "createdAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  );

  return rows.map((row) => {
    const revenue = money(row.revenue);
    const cost = money(row.cost);
    return {
      bucket: row.bucket,
      revenue,
      cost,
      profit: money(revenue.minus(cost)),
      orders: Number(row.orders),
    };
  });
}

export async function topProducts(branchId: string, range: DateRange, limit = 10) {
  const grouped = await prisma.orderItem.groupBy({
    by: ['productId', 'productName'],
    where: { order: completedWhere(branchId, range) },
    _sum: { quantity: true, lineTotal: true },
    orderBy: { _sum: { lineTotal: 'desc' } },
    take: limit,
  });

  const costs = await prisma.orderItem.groupBy({
    by: ['productId'],
    where: { order: completedWhere(branchId, range) },
    _sum: { quantity: true },
  });
  const qtyMap = new Map(costs.map((c) => [c.productId, c._sum.quantity ?? 0]));

  return grouped.map((row) => ({
    productId: row.productId,
    name: row.productName,
    quantitySold: row._sum.quantity ?? qtyMap.get(row.productId) ?? 0,
    revenue: money(row._sum.lineTotal ?? 0),
  }));
}

export async function categoryBreakdown(branchId: string, range: DateRange) {
  const rows = await prisma.$queryRaw<{ id: string; name: string; color: string; revenue: string; quantity: bigint }[]>(
    Prisma.sql`
      SELECT c."id", c."name", c."color",
             COALESCE(SUM(oi."lineTotal"), 0)::text AS revenue,
             COALESCE(SUM(oi."quantity"), 0)        AS quantity
      FROM "order_items" oi
      JOIN "orders" o     ON o."id" = oi."orderId"
      JOIN "products" p   ON p."id" = oi."productId"
      JOIN "categories" c ON c."id" = p."categoryId"
      WHERE o."branchId" = ${branchId}
        AND o."status" = 'COMPLETED'
        AND o."createdAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY c."id", c."name", c."color"
      ORDER BY revenue DESC
    `,
  );

  return rows.map((r) => ({
    categoryId: r.id,
    name: r.name,
    color: r.color,
    revenue: money(r.revenue),
    quantity: Number(r.quantity),
  }));
}

/** Peak-hours heat map, averaged across the days in range. */
export async function hourlyDistribution(branchId: string, range: DateRange) {
  const rows = await prisma.$queryRaw<{ hour: number; revenue: string; orders: bigint }[]>(
    Prisma.sql`
      SELECT EXTRACT(HOUR FROM "createdAt")::int AS hour,
             COALESCE(SUM("total"), 0)::text     AS revenue,
             COUNT(*)                            AS orders
      FROM "orders"
      WHERE "branchId" = ${branchId}
        AND "status" = 'COMPLETED'
        AND "createdAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY hour
      ORDER BY hour ASC
    `,
  );

  const map = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = map.get(hour);
    return { hour, revenue: money(row?.revenue ?? 0), orders: Number(row?.orders ?? 0) };
  });
}

export async function cashierPerformance(branchId: string, range: DateRange) {
  const grouped = await prisma.order.groupBy({
    by: ['cashierId'],
    where: completedWhere(branchId, range),
    _sum: { total: true },
    _count: { _all: true },
    _avg: { total: true },
    orderBy: { _sum: { total: 'desc' } },
  });

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.cashierId) } },
    select: { id: true, fullName: true, employeeCode: true, role: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return grouped.map((g) => ({
    cashier: userMap.get(g.cashierId) ?? { id: g.cashierId, fullName: 'Unknown', employeeCode: '-', role: 'CASHIER' },
    orders: g._count._all,
    revenue: money(g._sum.total ?? 0),
    averageTicket: money(g._avg.total ?? 0),
  }));
}

export async function expenseBreakdown(branchId: string, range: DateRange) {
  const grouped = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { branchId, spentAt: { gte: range.from, lte: range.to } },
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: { _sum: { amount: 'desc' } },
  });

  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: grouped.map((g) => g.categoryId) } },
    select: { id: true, name: true, isFixed: true },
  });
  const map = new Map(categories.map((c) => [c.id, c]));

  return grouped.map((g) => ({
    categoryId: g.categoryId,
    name: map.get(g.categoryId)?.name ?? 'Uncategorised',
    isFixed: map.get(g.categoryId)?.isFixed ?? false,
    count: g._count._all,
    amount: money(g._sum.amount ?? 0),
  }));
}

export async function inventoryValuation(branchId: string) {
  const stocks = await prisma.inventoryStock.findMany({
    where: { branchId, ingredient: { isActive: true } },
    include: { ingredient: { select: { id: true, name: true, unit: true, costPerUnit: true, lowStockAt: true } } },
  });

  const items = stocks.map((s) => ({
    ingredientId: s.ingredientId,
    name: s.ingredient.name,
    unit: s.ingredient.unit,
    quantity: s.quantity,
    costPerUnit: s.ingredient.costPerUnit,
    value: money(s.quantity.times(s.ingredient.costPerUnit)),
    isLow: s.quantity.lessThanOrEqualTo(s.ingredient.lowStockAt),
  }));

  return {
    items: items.sort((a, b) => toNumber(b.value) - toNumber(a.value)),
    totalValue: money(sum(items.map((i) => i.value))),
    lowStockCount: items.filter((i) => i.isLow).length,
  };
}

/** Single round-trip powering the live dashboard. */
export async function dashboard(branchId: string) {
  const now = new Date();
  const today = dayRange(now);
  const yesterday = dayRange(new Date(now.getTime() - 86_400_000));
  const thisMonth = monthRange(now.getFullYear(), now.getMonth() + 1);

  const [todaySummary, yesterdaySummary, monthSummary, series, top, categories, hourly, lowStockRows, recentOrders] =
    await Promise.all([
      summary(branchId, today),
      summary(branchId, yesterday),
      summary(branchId, thisMonth),
      salesSeries(branchId, { from: new Date(now.getTime() - 29 * 86_400_000), to: today.to }, 'day'),
      topProducts(branchId, thisMonth, 5),
      categoryBreakdown(branchId, thisMonth),
      hourlyDistribution(branchId, today),
      prisma.$queryRaw<{ count: bigint }[]>(
        Prisma.sql`
          SELECT COUNT(*) AS count
          FROM "inventory_stocks" s
          JOIN "ingredients" i ON i."id" = s."ingredientId"
          WHERE s."branchId" = ${branchId} AND i."isActive" = true AND s."quantity" <= i."lowStockAt"
        `,
      ),
      prisma.order.findMany({
        where: { branchId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          orderNumber: true,
          total: true,
          status: true,
          channel: true,
          createdAt: true,
          cashier: { select: { fullName: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

  const growth = (current: Prisma.Decimal, previous: Prisma.Decimal) =>
    previous.greaterThan(0) ? Number(current.minus(previous).dividedBy(previous).times(100).toFixed(1)) : current.greaterThan(0) ? 100 : 0;

  return {
    today: todaySummary,
    month: monthSummary,
    comparison: {
      revenueGrowth: growth(todaySummary.revenue.netRevenue, yesterdaySummary.revenue.netRevenue),
      orderGrowth: yesterdaySummary.orders.count > 0
        ? Number((((todaySummary.orders.count - yesterdaySummary.orders.count) / yesterdaySummary.orders.count) * 100).toFixed(1))
        : todaySummary.orders.count > 0
          ? 100
          : 0,
      profitGrowth: growth(todaySummary.profit.netProfit, yesterdaySummary.profit.netProfit),
    },
    salesTrend: series,
    topProducts: top,
    categoryBreakdown: categories,
    hourlyDistribution: hourly,
    lowStockCount: Number(lowStockRows[0]?.count ?? 0),
    recentOrders,
    generatedAt: now,
  };
}
