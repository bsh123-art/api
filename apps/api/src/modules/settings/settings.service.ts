import { z } from 'zod';
import { prisma } from '../../infra/prisma';

/**
 * Business rules that non-technical staff can change from the Settings screen.
 * Validated on read so a bad row can never crash the POS.
 */
export const settingsSchema = z.object({
  // Store identity — printed on receipts
  storeName: z.string().default('Kopi POS'),
  storeAddress: z.string().default(''),
  storePhone: z.string().default(''),
  storeEmail: z.string().default(''),
  receiptFooter: z.string().default('Thank you for your visit!'),
  receiptLogoUrl: z.string().default(''),

  // Money
  currency: z.string().default('IDR'),
  locale: z.string().default('id-ID'),
  taxEnabled: z.boolean().default(true),
  taxRate: z.number().min(0).max(1).default(0.11),
  taxInclusive: z.boolean().default(false),
  serviceChargeEnabled: z.boolean().default(false),
  serviceChargeRate: z.number().min(0).max(1).default(0.05),
  /** Cash rounding step, e.g. 100 rounds to the nearest 100 IDR. 0 disables it. */
  cashRounding: z.number().min(0).default(100),

  // Operations
  orderPrefix: z.string().default('INV'),
  allowNegativeStock: z.boolean().default(false),
  requireCustomerOnOrder: z.boolean().default(false),
  lowStockAlerts: z.boolean().default(true),
  loyaltyEnabled: z.boolean().default(true),
  /** Currency spent to earn one loyalty point. */
  loyaltyEarnRate: z.number().min(0).default(10_000),

  // Payments
  enabledPaymentMethods: z
    .array(z.enum(['CASH', 'QRIS', 'DEBIT_CARD', 'CREDIT_CARD', 'EWALLET', 'BANK_TRANSFER', 'VOUCHER']))
    .default(['CASH', 'QRIS', 'DEBIT_CARD', 'EWALLET']),
  qrisMerchantName: z.string().default(''),
  qrisStaticPayload: z.string().default(''),
  paymentFees: z.record(z.number().min(0).max(1)).default({ DEBIT_CARD: 0.007, CREDIT_CARD: 0.023, QRIS: 0.007 }),
});

export type AppSettings = z.infer<typeof settingsSchema>;

const CACHE_TTL_MS = 30_000;
let cache: { value: AppSettings; expiresAt: number } | null = null;

export async function getSettings(force = false): Promise<AppSettings> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value;

  const rows = await prisma.setting.findMany();
  const raw = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const value = settingsSchema.parse(raw);

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

const GROUPS: Record<string, string> = {
  storeName: 'store',
  storeAddress: 'store',
  storePhone: 'store',
  storeEmail: 'store',
  receiptFooter: 'receipt',
  receiptLogoUrl: 'receipt',
  currency: 'money',
  locale: 'money',
  taxEnabled: 'money',
  taxRate: 'money',
  taxInclusive: 'money',
  serviceChargeEnabled: 'money',
  serviceChargeRate: 'money',
  cashRounding: 'money',
  enabledPaymentMethods: 'payment',
  qrisMerchantName: 'payment',
  qrisStaticPayload: 'payment',
  paymentFees: 'payment',
};

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings(true);
  const next = settingsSchema.parse({ ...current, ...patch });

  await prisma.$transaction(
    Object.entries(patch).map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        create: { key, value: value as object, group: GROUPS[key] ?? 'general' },
        update: { value: value as object },
      }),
    ),
  );

  invalidateSettingsCache();
  return next;
}
