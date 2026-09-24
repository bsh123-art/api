import { Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../../core/errors';
import { money } from '../../core/money';
import { prisma } from '../../infra/prisma';

const nextCode = async () => {
  const count = await prisma.customer.count();
  return `CUS${String(count + 1).padStart(5, '0')}`;
};

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  birthDate?: Date | null;
  note?: string | null;
  isActive?: boolean;
}

export async function listCustomers(filters: { search?: string; skip: number; take: number; sortBy?: string; sortOrder: 'asc' | 'desc' }) {
  const where: Prisma.CustomerWhereInput = filters.search
    ? {
        OR: [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { phone: { contains: filters.search } },
          { email: { contains: filters.search, mode: 'insensitive' } },
          { code: { contains: filters.search, mode: 'insensitive' } },
        ],
      }
    : {};

  const sortable = new Set(['name', 'totalSpent', 'visitCount', 'loyaltyPoints', 'lastVisitAt', 'createdAt']);
  const orderBy = sortable.has(filters.sortBy ?? '')
    ? { [filters.sortBy as string]: filters.sortOrder }
    : { createdAt: filters.sortOrder };

  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy, skip: filters.skip, take: filters.take }),
    prisma.customer.count({ where }),
  ]);

  return { items, total };
}

export async function getCustomer(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      orders: {
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, orderNumber: true, total: true, createdAt: true, channel: true, _count: { select: { items: true } } },
      },
    },
  });
  if (!customer) throw new NotFoundError('Customer');

  const favourites = await prisma.orderItem.groupBy({
    by: ['productName'],
    where: { order: { customerId: id, status: 'COMPLETED' } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: 5,
  });

  return {
    ...customer,
    averageTicket: customer.visitCount > 0 ? money(customer.totalSpent.dividedBy(customer.visitCount)) : money(0),
    favourites: favourites.map((f) => ({ product: f.productName, quantity: f._sum.quantity ?? 0 })),
  };
}

export const createCustomer = async (input: CustomerInput) =>
  prisma.customer.create({ data: { ...input, code: await nextCode() } });

export const updateCustomer = (id: string, input: Partial<CustomerInput>) =>
  prisma.customer.update({ where: { id }, data: input });

export const deactivateCustomer = (id: string) => prisma.customer.update({ where: { id }, data: { isActive: false } });

/** Redeems loyalty points; returns the remaining balance. */
export async function redeemPoints(id: string, points: number) {
  const customer = await prisma.customer.findUnique({ where: { id }, select: { loyaltyPoints: true } });
  if (!customer) throw new NotFoundError('Customer');
  if (customer.loyaltyPoints < points) {
    throw new BadRequestError(`This customer only has ${customer.loyaltyPoints} point(s) available`);
  }
  return prisma.customer.update({ where: { id }, data: { loyaltyPoints: { decrement: points } } });
}
