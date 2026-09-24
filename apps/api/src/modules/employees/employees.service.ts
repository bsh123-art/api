import { EmploymentStatus, Prisma, Role, ShiftStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../core/errors';
import { money, sum } from '../../core/money';
import { prisma } from '../../infra/prisma';
import { hashPassword, logoutAll, toPublicUser } from '../auth/auth.service';

const select = {
  id: true,
  employeeCode: true,
  email: true,
  fullName: true,
  phone: true,
  role: true,
  status: true,
  avatarUrl: true,
  hourlyRate: true,
  hiredAt: true,
  lastLoginAt: true,
  branchId: true,
  createdAt: true,
  branch: { select: { id: true, name: true, code: true } },
} satisfies Prisma.UserSelect;

const nextEmployeeCode = async () => {
  const count = await prisma.user.count();
  return `EMP${String(count + 1).padStart(4, '0')}`;
};

export interface EmployeeInput {
  email: string;
  password?: string;
  fullName: string;
  phone?: string | null;
  role: Role;
  branchId?: string | null;
  hourlyRate?: number | null;
  hiredAt?: Date | null;
  status?: EmploymentStatus;
}

export async function listEmployees(filters: { search?: string; role?: Role; status?: EmploymentStatus; branchId?: string; skip: number; take: number }) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.search
      ? {
          OR: [
            { fullName: { contains: filters.search, mode: 'insensitive' } },
            { email: { contains: filters.search, mode: 'insensitive' } },
            { employeeCode: { contains: filters.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, select, orderBy: { createdAt: 'desc' }, skip: filters.skip, take: filters.take }),
    prisma.user.count({ where }),
  ]);

  return { items, total };
}

export async function getEmployee(id: string) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null }, select });
  if (!user) throw new NotFoundError('Employee');
  return user;
}

export async function createEmployee(input: EmployeeInput) {
  if (!input.password) throw new ConflictError('A password is required for a new employee');
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw new ConflictError('An account with this email already exists');

  const { password, ...rest } = input;
  return prisma.user.create({
    data: {
      ...rest,
      employeeCode: await nextEmployeeCode(),
      passwordHash: await hashPassword(password),
      hourlyRate: rest.hourlyRate != null ? money(rest.hourlyRate) : null,
    },
    select,
  });
}

export async function updateEmployee(id: string, input: Partial<EmployeeInput>) {
  const { password, ...rest } = input;
  const user = await prisma.user.update({
    where: { id },
    data: {
      ...rest,
      ...(rest.hourlyRate != null ? { hourlyRate: money(rest.hourlyRate) } : {}),
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    },
    select,
  });

  // Any credential or access change invalidates existing sessions.
  if (password || input.role || input.status || input.branchId !== undefined) await logoutAll(id);
  return user;
}

/** Soft-delete keeps historic orders attributable to the employee. */
export async function deactivateEmployee(id: string) {
  const orderCount = await prisma.order.count({ where: { cashierId: id } });
  await prisma.user.update({
    where: { id },
    data: {
      status: EmploymentStatus.TERMINATED,
      ...(orderCount === 0 ? { deletedAt: new Date() } : {}),
    },
  });
  await logoutAll(id);
}

export async function resetPassword(id: string, newPassword: string) {
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(newPassword), failedLogins: 0, lockedUntil: null } });
  await logoutAll(id);
}

export async function profileOf(id: string) {
  const user = await prisma.user.findFirstOrThrow({ where: { id }, include: { branch: { select: { id: true, name: true, code: true } } } });
  return toPublicUser(user);
}

// --------------------------------------------------------------------------
// Cash drawer shifts
// --------------------------------------------------------------------------

export async function openShift(branchId: string, userId: string, openingCash: number) {
  const active = await prisma.shift.findFirst({ where: { branchId, userId, status: ShiftStatus.OPEN } });
  if (active) throw new ConflictError('You already have an open shift — close it before starting a new one');

  return prisma.shift.create({ data: { branchId, userId, openingCash: money(openingCash) } });
}

export async function currentShift(branchId: string, userId: string) {
  return prisma.shift.findFirst({
    where: { branchId, userId, status: ShiftStatus.OPEN },
    include: { user: { select: { id: true, fullName: true } } },
  });
}

/** Closes the drawer and reconciles counted cash against expected cash. */
export async function closeShift(branchId: string, userId: string, closingCash: number, note?: string) {
  const shift = await prisma.shift.findFirst({ where: { branchId, userId, status: ShiftStatus.OPEN } });
  if (!shift) throw new NotFoundError('Open shift');

  const cashPayments = await prisma.payment.findMany({
    where: { method: 'CASH', status: 'PAID', order: { shiftId: shift.id, status: 'COMPLETED' } },
    select: { amount: true },
  });
  const orders = await prisma.order.findMany({ where: { shiftId: shift.id, status: 'COMPLETED' }, select: { changeAmount: true } });
  const cashExpenses = await prisma.expense.aggregate({
    where: { branchId, paymentMethod: 'CASH', spentAt: { gte: shift.openedAt } },
    _sum: { amount: true },
  });

  const cashIn = sum(cashPayments.map((p) => p.amount));
  const changeOut = sum(orders.map((o) => o.changeAmount));
  const expected = money(shift.openingCash.plus(cashIn).minus(changeOut).minus(cashExpenses._sum.amount ?? 0));
  const counted = money(closingCash);

  return prisma.shift.update({
    where: { id: shift.id },
    data: {
      status: ShiftStatus.CLOSED,
      closingCash: counted,
      expectedCash: expected,
      difference: money(counted.minus(expected)),
      note: note ?? null,
      closedAt: new Date(),
    },
    include: { user: { select: { id: true, fullName: true } } },
  });
}

export async function listShifts(branchId: string, filters: { userId?: string; from?: Date; to?: Date; skip: number; take: number }) {
  const where: Prisma.ShiftWhereInput = {
    branchId,
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.from || filters.to
      ? { openedAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.shift.findMany({
      where,
      include: { user: { select: { id: true, fullName: true, employeeCode: true } }, _count: { select: { orders: true } } },
      orderBy: { openedAt: 'desc' },
      skip: filters.skip,
      take: filters.take,
    }),
    prisma.shift.count({ where }),
  ]);

  return { items, total };
}
