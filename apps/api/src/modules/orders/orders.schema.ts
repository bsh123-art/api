import { z } from 'zod';
import { OrderChannel, PaymentMethod, StockMovementType } from '@prisma/client';

export const orderItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullish(),
  quantity: z.number().int().min(1).max(999),
  /** Per-line discount in currency units, applied before order-level discount. */
  discountAmount: z.number().min(0).default(0),
  note: z.string().max(255).nullish(),
});

export const paymentSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  amount: z.number().min(0),
  referenceNo: z.string().max(120).nullish(),
});

const orderBaseSchema = z.object({
  /** Client-generated UUID. Guarantees an offline replay posts exactly once. */
  idempotencyKey: z.string().uuid().optional(),
  customerId: z.string().uuid().nullish(),
  channel: z.nativeEnum(OrderChannel).default(OrderChannel.DINE_IN),
  tableNumber: z.string().max(20).nullish(),
  items: z.array(orderItemSchema).min(1, 'An order needs at least one item'),
  payments: z.array(paymentSchema).min(1, 'At least one payment is required'),
  discountType: z.enum(['PERCENTAGE', 'FIXED']).nullish(),
  discountValue: z.number().min(0).nullish(),
  note: z.string().max(500).nullish(),
  clientCreatedAt: z.coerce.date().optional(),
});

const DISCOUNT_REQUIRED = {
  message: 'Discount value is required when a discount type is set',
  path: ['discountValue'],
};

const DISCOUNT_MAX = {
  message: 'Percentage discount cannot exceed 100',
  path: ['discountValue'],
};

// Refinements are applied inline rather than through a generic helper: wrapping
// them in one would erase Zod's inferred output type at every call site.
export const createOrderSchema = orderBaseSchema
  .refine((v) => !v.discountType || (v.discountValue ?? 0) >= 0, DISCOUNT_REQUIRED)
  .refine((v) => v.discountType !== 'PERCENTAGE' || (v.discountValue ?? 0) <= 100, DISCOUNT_MAX);

/** Pricing preview: same shape as a sale but payments are not required yet. */
export const quoteOrderSchema = orderBaseSchema
  .extend({ payments: z.array(paymentSchema).default([]) })
  .refine((v) => !v.discountType || (v.discountValue ?? 0) >= 0, DISCOUNT_REQUIRED)
  .refine((v) => v.discountType !== 'PERCENTAGE' || (v.discountValue ?? 0) <= 100, DISCOUNT_MAX);

export const voidOrderSchema = z.object({
  reason: z.string().min(3, 'Please state why this order is being voided').max(255),
  restock: z.boolean().default(true),
});

export const refundOrderSchema = z.object({
  reason: z.string().min(3).max(255),
  restock: z.boolean().default(false),
});

export const orderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'COMPLETED', 'VOIDED', 'REFUNDED']).optional(),
  channel: z.nativeEnum(OrderChannel).optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  cashierId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const stockAdjustSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().refine((v) => v !== 0, 'Quantity cannot be zero'),
  type: z.nativeEnum(StockMovementType).default(StockMovementType.ADJUSTMENT),
  note: z.string().max(255).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type QuoteOrderInput = z.infer<typeof quoteOrderSchema>;
export type OrderQuery = z.infer<typeof orderQuerySchema>;
