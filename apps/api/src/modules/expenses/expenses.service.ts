import { Prisma, type PaymentMethod } from '@prisma/client';
import { NotFoundError } from '../../core/errors';
import { money } from '../../core/money';
import { prisma } from '../../infra/prisma';

export interface ExpenseInput {
  categoryId: string;
  title: string;
  amount: number;
  paymentMethod?: PaymentMethod;
  vendor?: string | null;
  receiptUrl?: string | null;
  note?: string | null;
  spentAt: Date;
}

const include = {
  category: { select: { id: true, name: true, isFixed: true } },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ExpenseInclude;

export async function listExpenses(branchId: string, filters: {
  search?: string;
  categoryId?: string;
  from?: Date;
  to?: Date;
  skip: number;
  take: number;
}) {
  const where: Prisma.ExpenseWhereInput = {
    branchId,
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.from || filters.to
      ? { spentAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search, mode: 'insensitive' } },
            { vendor: { contains: filters.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total, aggregate] = await Promise.all([
    prisma.expense.findMany({ where, include, orderBy: { spentAt: 'desc' }, skip: filters.skip, take: filters.take }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, totalAmount: money(aggregate._sum.amount ?? 0) };
}

export const createExpense = (branchId: string, userId: string, input: ExpenseInput) =>
  prisma.expense.create({
    data: { ...input, amount: money(input.amount), branchId, createdById: userId },
    include,
  });

export async function updateExpense(branchId: string, id: string, input: Partial<ExpenseInput>) {
  const existing = await prisma.expense.findFirst({ where: { id, branchId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Expense');
  return prisma.expense.update({
    where: { id },
    data: { ...input, ...(input.amount != null ? { amount: money(input.amount) } : {}) },
    include,
  });
}

export async function deleteExpense(branchId: string, id: string) {
  const existing = await prisma.expense.findFirst({ where: { id, branchId }, select: { id: true } });
  if (!existing) throw new NotFoundError('Expense');
  await prisma.expense.delete({ where: { id } });
}

export const listCategories = () =>
  prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });

export const createCategory = (data: { name: string; isFixed?: boolean }) =>
  prisma.expenseCategory.create({ data });

export const updateCategory = (id: string, data: { name?: string; isFixed?: boolean; isActive?: boolean }) =>
  prisma.expenseCategory.update({ where: { id }, data });
