import { Prisma } from '@prisma/client';

export const D = Prisma.Decimal;
export type Money = Prisma.Decimal;

/** Rounds half-up to 2 dp — the rounding rule used for all monetary values. */
export const money = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(value ?? 0).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Quantities keep 4 dp so fractional grams/millilitres stay accurate. */
export const qty = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(value ?? 0).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

export const zero = () => new Prisma.Decimal(0);

export const sum = (values: Prisma.Decimal.Value[]): Prisma.Decimal =>
  values.reduce<Prisma.Decimal>((acc, v) => acc.plus(new Prisma.Decimal(v ?? 0)), new Prisma.Decimal(0));

export const toNumber = (value: Prisma.Decimal.Value | null | undefined): number =>
  value == null ? 0 : new Prisma.Decimal(value).toNumber();

/**
 * JSON replacer used by Express. Prisma Decimals serialise to strings by
 * default which forces string maths in the browser — emit numbers instead.
 */
export function decimalJsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this?.[key];
  if (Prisma.Decimal.isDecimal(raw)) return (raw as Prisma.Decimal).toNumber();
  if (typeof raw === 'bigint') return Number(raw);
  return value;
}

/** Applies "round to nearest N" cash rounding (e.g. 100 IDR). */
export const roundToNearest = (value: Prisma.Decimal.Value, nearest: number): Prisma.Decimal => {
  if (!nearest || nearest <= 0) return money(value);
  const n = new Prisma.Decimal(nearest);
  return money(new Prisma.Decimal(value).dividedBy(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).times(n));
};
