import { Router } from 'express';
import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, buildPageMeta, created, noContent, ok, paginated, paginationSchema, skipTake } from '../../core/http';
import { authorize, requireBranch, requireUser, resolveBranch } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { validateBody, validateQuery } from '../../middleware/validate';
import * as service from './expenses.service';

const idParam = z.string().uuid();

const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  title: z.string().trim().min(1).max(150),
  amount: z.number().positive('Amount must be greater than zero'),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  vendor: z.string().max(120).nullish(),
  receiptUrl: z.string().url().max(500).nullish().or(z.literal('')),
  note: z.string().max(500).nullish(),
  spentAt: z.coerce.date(),
});

export const expensesRouter = Router();
expensesRouter.use(resolveBranch);

expensesRouter.get('/categories', asyncHandler(async (_req, res) => ok(res, await service.listCategories())));

expensesRouter.post(
  '/categories',
  authorize('MANAGER'),
  validateBody(z.object({ name: z.string().trim().min(1).max(60), isFixed: z.boolean().optional() })),
  audit('expense_category.create', 'ExpenseCategory'),
  asyncHandler(async (req, res) => created(res, await service.createCategory(req.body))),
);

expensesRouter.patch(
  '/categories/:id',
  authorize('MANAGER'),
  validateBody(z.object({ name: z.string().trim().min(1).max(60).optional(), isFixed: z.boolean().optional(), isActive: z.boolean().optional() })),
  audit('expense_category.update', 'ExpenseCategory'),
  asyncHandler(async (req, res) => ok(res, await service.updateCategory(idParam.parse(req.params.id), req.body))),
);

expensesRouter.get(
  '/',
  validateQuery(paginationSchema.extend({ categoryId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationSchema> & { categoryId?: string; from?: Date; to?: Date };
    const { items, total, totalAmount } = await service.listExpenses(requireBranch(req), { ...query, ...skipTake(query) });
    return paginated(res, items, { ...buildPageMeta(total, query.page, query.pageSize), totalAmount });
  }),
);

expensesRouter.post(
  '/',
  validateBody(expenseSchema),
  audit('expense.create', 'Expense'),
  asyncHandler(async (req, res) =>
    created(res, await service.createExpense(requireBranch(req), requireUser(req).sub, req.body)),
  ),
);

expensesRouter.patch(
  '/:id',
  authorize('MANAGER'),
  validateBody(expenseSchema.partial()),
  audit('expense.update', 'Expense'),
  asyncHandler(async (req, res) => ok(res, await service.updateExpense(requireBranch(req), idParam.parse(req.params.id), req.body))),
);

expensesRouter.delete(
  '/:id',
  authorize('MANAGER'),
  audit('expense.delete', 'Expense'),
  asyncHandler(async (req, res) => {
    await service.deleteExpense(requireBranch(req), idParam.parse(req.params.id));
    return noContent(res);
  }),
);
