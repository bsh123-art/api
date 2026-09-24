import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../core/http';
import { toNumber } from '../../core/money';
import { authorize, requireBranch, resolveBranch } from '../../middleware/auth';
import { validateQuery } from '../../middleware/validate';
import { buildWorkbook } from '../platform/backup.service';
import * as service from './reports.service';

const rangeQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** Convenience preset used by the UI date picker. */
    preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear']).optional(),
    granularity: z.enum(['hour', 'day', 'month']).default('day'),
  })
  .transform((v) => {
    const now = new Date();
    const range =
      v.from && v.to
        ? { from: service.startOfDay(v.from), to: service.endOfDay(v.to) }
        : resolvePreset(v.preset, now);
    return { ...range, granularity: v.granularity };
  });

function resolvePreset(preset: string | undefined, now: Date): service.DateRange {
  switch (preset) {
    case 'yesterday':
      return service.dayRange(new Date(now.getTime() - 86_400_000));
    case 'last7':
      return { from: service.startOfDay(new Date(now.getTime() - 6 * 86_400_000)), to: service.endOfDay(now) };
    case 'last30':
      return { from: service.startOfDay(new Date(now.getTime() - 29 * 86_400_000)), to: service.endOfDay(now) };
    case 'thisMonth':
      return service.monthRange(now.getFullYear(), now.getMonth() + 1);
    case 'lastMonth':
      return service.monthRange(now.getFullYear(), now.getMonth() || 12);
    case 'thisYear':
      return { from: new Date(now.getFullYear(), 0, 1), to: service.endOfDay(now) };
    default:
      return service.dayRange(now);
  }
}

type RangeQuery = z.infer<typeof rangeQuery>;

export const reportsRouter = Router();
reportsRouter.use(resolveBranch);

reportsRouter.get('/dashboard', asyncHandler(async (req, res) => ok(res, await service.dashboard(requireBranch(req)))));

reportsRouter.get(
  '/summary',
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) => ok(res, await service.summary(requireBranch(req), req.query as unknown as RangeQuery))),
);

reportsRouter.get(
  '/sales-series',
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as RangeQuery;
    return ok(res, await service.salesSeries(requireBranch(req), query, query.granularity));
  }),
);

reportsRouter.get(
  '/top-products',
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) =>
    ok(res, await service.topProducts(requireBranch(req), req.query as unknown as RangeQuery, 20)),
  ),
);

reportsRouter.get(
  '/categories',
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) =>
    ok(res, await service.categoryBreakdown(requireBranch(req), req.query as unknown as RangeQuery)),
  ),
);

reportsRouter.get(
  '/hourly',
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) =>
    ok(res, await service.hourlyDistribution(requireBranch(req), req.query as unknown as RangeQuery)),
  ),
);

reportsRouter.get(
  '/cashiers',
  authorize('MANAGER'),
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) =>
    ok(res, await service.cashierPerformance(requireBranch(req), req.query as unknown as RangeQuery)),
  ),
);

reportsRouter.get(
  '/expenses',
  authorize('MANAGER'),
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) =>
    ok(res, await service.expenseBreakdown(requireBranch(req), req.query as unknown as RangeQuery)),
  ),
);

reportsRouter.get(
  '/inventory-valuation',
  authorize('MANAGER'),
  asyncHandler(async (req, res) => ok(res, await service.inventoryValuation(requireBranch(req)))),
);

/** Full period pack as a styled multi-sheet workbook. */
reportsRouter.get(
  '/export',
  authorize('MANAGER'),
  validateQuery(rangeQuery),
  asyncHandler(async (req, res) => {
    const branchId = requireBranch(req);
    const range = req.query as unknown as RangeQuery;

    const [summary, series, products, categories, cashiers, expenses, valuation] = await Promise.all([
      service.summary(branchId, range),
      service.salesSeries(branchId, range, 'day'),
      service.topProducts(branchId, range, 200),
      service.categoryBreakdown(branchId, range),
      service.cashierPerformance(branchId, range),
      service.expenseBreakdown(branchId, range),
      service.inventoryValuation(branchId),
    ]);

    const workbook = await buildWorkbook([
      {
        name: 'Summary',
        columns: [
          { header: 'Metric', key: 'metric', width: 28 },
          { header: 'Value', key: 'value', width: 20 },
        ],
        rows: [
          { metric: 'Period start', value: range.from.toISOString().slice(0, 10) },
          { metric: 'Period end', value: range.to.toISOString().slice(0, 10) },
          { metric: 'Orders', value: summary.orders.count },
          { metric: 'Items sold', value: summary.orders.itemsSold },
          { metric: 'Average ticket', value: toNumber(summary.orders.averageTicket) },
          { metric: 'Gross sales', value: toNumber(summary.revenue.grossSales) },
          { metric: 'Discounts', value: toNumber(summary.revenue.discounts) },
          { metric: 'Net revenue', value: toNumber(summary.revenue.netRevenue) },
          { metric: 'Tax collected', value: toNumber(summary.revenue.tax) },
          { metric: 'COGS', value: toNumber(summary.costs.cogs) },
          { metric: 'Operating expenses', value: toNumber(summary.costs.operatingExpenses) },
          { metric: 'Payment fees', value: toNumber(summary.costs.paymentFees) },
          { metric: 'Gross profit', value: toNumber(summary.profit.grossProfit) },
          { metric: 'Net profit', value: toNumber(summary.profit.netProfit) },
          { metric: 'Net margin %', value: summary.profit.netMarginPercent },
        ],
      },
      {
        name: 'Daily Sales',
        columns: [
          { header: 'Date', key: 'date', width: 14 },
          { header: 'Orders', key: 'orders', width: 10 },
          { header: 'Revenue', key: 'revenue', width: 16 },
          { header: 'Cost', key: 'cost', width: 16 },
          { header: 'Profit', key: 'profit', width: 16 },
        ],
        rows: series.map((s) => ({
          date: new Date(s.bucket).toISOString().slice(0, 10),
          orders: s.orders,
          revenue: toNumber(s.revenue),
          cost: toNumber(s.cost),
          profit: toNumber(s.profit),
        })),
      },
      {
        name: 'Products',
        columns: [
          { header: 'Product', key: 'name', width: 32 },
          { header: 'Qty sold', key: 'quantitySold', width: 12 },
          { header: 'Revenue', key: 'revenue', width: 16 },
        ],
        rows: products.map((p) => ({ name: p.name, quantitySold: p.quantitySold, revenue: toNumber(p.revenue) })),
      },
      {
        name: 'Categories',
        columns: [
          { header: 'Category', key: 'name', width: 28 },
          { header: 'Qty', key: 'quantity', width: 12 },
          { header: 'Revenue', key: 'revenue', width: 16 },
        ],
        rows: categories.map((c) => ({ name: c.name, quantity: c.quantity, revenue: toNumber(c.revenue) })),
      },
      {
        name: 'Cashiers',
        columns: [
          { header: 'Employee', key: 'name', width: 28 },
          { header: 'Code', key: 'code', width: 12 },
          { header: 'Orders', key: 'orders', width: 10 },
          { header: 'Revenue', key: 'revenue', width: 16 },
          { header: 'Avg ticket', key: 'avg', width: 16 },
        ],
        rows: cashiers.map((c) => ({
          name: c.cashier.fullName,
          code: c.cashier.employeeCode,
          orders: c.orders,
          revenue: toNumber(c.revenue),
          avg: toNumber(c.averageTicket),
        })),
      },
      {
        name: 'Expenses',
        columns: [
          { header: 'Category', key: 'name', width: 28 },
          { header: 'Entries', key: 'count', width: 10 },
          { header: 'Amount', key: 'amount', width: 16 },
          { header: 'Fixed cost', key: 'isFixed', width: 12 },
        ],
        rows: expenses.map((e) => ({ name: e.name, count: e.count, amount: toNumber(e.amount), isFixed: e.isFixed ? 'Yes' : 'No' })),
      },
      {
        name: 'Inventory',
        columns: [
          { header: 'Ingredient', key: 'name', width: 30 },
          { header: 'Unit', key: 'unit', width: 12 },
          { header: 'On hand', key: 'quantity', width: 14 },
          { header: 'Cost/unit', key: 'costPerUnit', width: 14 },
          { header: 'Value', key: 'value', width: 16 },
          { header: 'Low stock', key: 'isLow', width: 12 },
        ],
        rows: valuation.items.map((i) => ({
          name: i.name,
          unit: i.unit,
          quantity: toNumber(i.quantity),
          costPerUnit: toNumber(i.costPerUnit),
          value: toNumber(i.value),
          isLow: i.isLow ? 'Yes' : 'No',
        })),
      },
    ]);

    const fileName = `kopi-report-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(workbook);
  }),
);
