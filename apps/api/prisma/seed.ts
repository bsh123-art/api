/**
 * Idempotent seed: safe to run repeatedly. Creates the default branch, staff
 * accounts, a realistic coffee-shop catalog with recipes, and opening stock.
 */
import { PaymentMethod, PrismaClient, Role, StockMovementType, UnitType } from '@prisma/client';
import argon2 from 'argon2';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

const hash = (plain: string) => argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

const INGREDIENTS = [
  { sku: 'ING-COFFEE', name: 'Espresso Beans (Arabica)', unit: UnitType.GRAM, costPerUnit: 180, lowStockAt: 2000, reorderQty: 10000, opening: 12000 },
  { sku: 'ING-MILK', name: 'Fresh Milk', unit: UnitType.MILLILITER, costPerUnit: 18, lowStockAt: 5000, reorderQty: 20000, opening: 24000 },
  { sku: 'ING-OATMILK', name: 'Oat Milk', unit: UnitType.MILLILITER, costPerUnit: 42, lowStockAt: 2000, reorderQty: 8000, opening: 6000 },
  { sku: 'ING-CHOCO', name: 'Chocolate Powder', unit: UnitType.GRAM, costPerUnit: 95, lowStockAt: 500, reorderQty: 3000, opening: 3000 },
  { sku: 'ING-MATCHA', name: 'Matcha Powder', unit: UnitType.GRAM, costPerUnit: 480, lowStockAt: 300, reorderQty: 1000, opening: 900 },
  { sku: 'ING-SUGAR', name: 'Sugar Syrup', unit: UnitType.MILLILITER, costPerUnit: 12, lowStockAt: 1000, reorderQty: 5000, opening: 5000 },
  { sku: 'ING-CARAMEL', name: 'Caramel Sauce', unit: UnitType.MILLILITER, costPerUnit: 65, lowStockAt: 500, reorderQty: 2000, opening: 2000 },
  { sku: 'ING-ICE', name: 'Ice Cubes', unit: UnitType.GRAM, costPerUnit: 2, lowStockAt: 5000, reorderQty: 30000, opening: 40000 },
  { sku: 'ING-CUP-HOT', name: 'Hot Cup 8oz + Lid', unit: UnitType.PIECE, costPerUnit: 1200, lowStockAt: 100, reorderQty: 1000, opening: 800 },
  { sku: 'ING-CUP-COLD', name: 'Cold Cup 16oz + Lid', unit: UnitType.PIECE, costPerUnit: 1500, lowStockAt: 100, reorderQty: 1000, opening: 750 },
  { sku: 'ING-CROISSANT', name: 'Butter Croissant (frozen)', unit: UnitType.PIECE, costPerUnit: 7500, lowStockAt: 20, reorderQty: 100, opening: 60 },
  { sku: 'ING-BREAD', name: 'Sourdough Slice', unit: UnitType.PIECE, costPerUnit: 3500, lowStockAt: 20, reorderQty: 120, opening: 80 },
  { sku: 'ING-CHEESE', name: 'Cheddar Cheese', unit: UnitType.GRAM, costPerUnit: 140, lowStockAt: 500, reorderQty: 2000, opening: 1800 },
  { sku: 'ING-TEA', name: 'Black Tea Leaves', unit: UnitType.GRAM, costPerUnit: 220, lowStockAt: 200, reorderQty: 1000, opening: 900 },
];

const CATEGORIES = [
  { name: 'Espresso Bar', color: '#6F4E37', icon: 'coffee', sortOrder: 1 },
  { name: 'Manual Brew', color: '#A9746E', icon: 'beaker', sortOrder: 2 },
  { name: 'Non-Coffee', color: '#7BA05B', icon: 'leaf', sortOrder: 3 },
  { name: 'Pastry & Snacks', color: '#D4A574', icon: 'croissant', sortOrder: 4 },
];

interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  price: number;
  barcode?: string;
  favorite?: boolean;
  variants?: { name: string; priceDelta: number; multiplier: number; isDefault?: boolean }[];
  recipe: { sku: string; quantity: number }[];
}

const PRODUCTS: SeedProduct[] = [
  {
    sku: 'ESP-001', name: 'Espresso', category: 'Espresso Bar', price: 22000, barcode: '8991234000011',
    variants: [{ name: 'Single', priceDelta: 0, multiplier: 1, isDefault: true }, { name: 'Double', priceDelta: 8000, multiplier: 2 }],
    recipe: [{ sku: 'ING-COFFEE', quantity: 18 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'ESP-002', name: 'Americano', category: 'Espresso Bar', price: 25000, barcode: '8991234000028', favorite: true,
    variants: [{ name: 'Hot', priceDelta: 0, multiplier: 1, isDefault: true }, { name: 'Iced', priceDelta: 3000, multiplier: 1.1 }],
    recipe: [{ sku: 'ING-COFFEE', quantity: 18 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'ESP-003', name: 'Caffè Latte', category: 'Espresso Bar', price: 32000, barcode: '8991234000035', favorite: true,
    variants: [
      { name: 'Regular', priceDelta: 0, multiplier: 1, isDefault: true },
      { name: 'Large', priceDelta: 7000, multiplier: 1.4 },
      { name: 'Oat Milk', priceDelta: 10000, multiplier: 1 },
    ],
    recipe: [{ sku: 'ING-COFFEE', quantity: 18 }, { sku: 'ING-MILK', quantity: 180 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'ESP-004', name: 'Cappuccino', category: 'Espresso Bar', price: 30000, barcode: '8991234000042',
    recipe: [{ sku: 'ING-COFFEE', quantity: 18 }, { sku: 'ING-MILK', quantity: 150 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'ESP-005', name: 'Caramel Macchiato', category: 'Espresso Bar', price: 38000, barcode: '8991234000059', favorite: true,
    variants: [{ name: 'Hot', priceDelta: 0, multiplier: 1, isDefault: true }, { name: 'Iced', priceDelta: 3000, multiplier: 1.2 }],
    recipe: [
      { sku: 'ING-COFFEE', quantity: 18 }, { sku: 'ING-MILK', quantity: 180 },
      { sku: 'ING-CARAMEL', quantity: 20 }, { sku: 'ING-CUP-COLD', quantity: 1 },
    ],
  },
  {
    sku: 'BRW-001', name: 'V60 Pour Over', category: 'Manual Brew', price: 35000, barcode: '8991234000066',
    recipe: [{ sku: 'ING-COFFEE', quantity: 20 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'BRW-002', name: 'Cold Brew', category: 'Manual Brew', price: 34000, barcode: '8991234000073',
    recipe: [{ sku: 'ING-COFFEE', quantity: 30 }, { sku: 'ING-ICE', quantity: 150 }, { sku: 'ING-CUP-COLD', quantity: 1 }],
  },
  {
    sku: 'NON-001', name: 'Matcha Latte', category: 'Non-Coffee', price: 36000, barcode: '8991234000080', favorite: true,
    variants: [{ name: 'Hot', priceDelta: 0, multiplier: 1, isDefault: true }, { name: 'Iced', priceDelta: 3000, multiplier: 1.2 }],
    recipe: [
      { sku: 'ING-MATCHA', quantity: 8 }, { sku: 'ING-MILK', quantity: 200 },
      { sku: 'ING-SUGAR', quantity: 15 }, { sku: 'ING-CUP-COLD', quantity: 1 },
    ],
  },
  {
    sku: 'NON-002', name: 'Chocolate', category: 'Non-Coffee', price: 33000, barcode: '8991234000097',
    recipe: [{ sku: 'ING-CHOCO', quantity: 30 }, { sku: 'ING-MILK', quantity: 200 }, { sku: 'ING-CUP-HOT', quantity: 1 }],
  },
  {
    sku: 'NON-003', name: 'Lemon Tea', category: 'Non-Coffee', price: 24000, barcode: '8991234000103',
    recipe: [{ sku: 'ING-TEA', quantity: 5 }, { sku: 'ING-SUGAR', quantity: 20 }, { sku: 'ING-CUP-COLD', quantity: 1 }],
  },
  {
    sku: 'PST-001', name: 'Butter Croissant', category: 'Pastry & Snacks', price: 28000, barcode: '8991234000110',
    recipe: [{ sku: 'ING-CROISSANT', quantity: 1 }],
  },
  {
    sku: 'PST-002', name: 'Grilled Cheese Toast', category: 'Pastry & Snacks', price: 32000, barcode: '8991234000127',
    recipe: [{ sku: 'ING-BREAD', quantity: 2 }, { sku: 'ING-CHEESE', quantity: 40 }],
  },
];

const EXPENSE_CATEGORIES = [
  { name: 'Rent', isFixed: true },
  { name: 'Salaries & Wages', isFixed: true },
  { name: 'Electricity & Water', isFixed: false },
  { name: 'Internet & Phone', isFixed: true },
  { name: 'Marketing', isFixed: false },
  { name: 'Equipment Maintenance', isFixed: false },
  { name: 'Packaging & Supplies', isFixed: false },
  { name: 'Miscellaneous', isFixed: false },
];

const SETTINGS: Record<string, unknown> = {
  storeName: 'Kopi Nusantara',
  storeAddress: 'Jl. Merdeka No. 12, Jakarta Pusat',
  storePhone: '+62 21 5550 1234',
  receiptFooter: 'Terima kasih atas kunjungan Anda!\nFollow us @kopinusantara',
  currency: 'IDR',
  locale: 'id-ID',
  taxEnabled: true,
  taxRate: 0.11,
  taxInclusive: false,
  serviceChargeEnabled: false,
  serviceChargeRate: 0.05,
  cashRounding: 100,
  orderPrefix: 'INV',
  lowStockAlerts: true,
  loyaltyEnabled: true,
  loyaltyEarnRate: 10000,
  enabledPaymentMethods: [PaymentMethod.CASH, PaymentMethod.QRIS, PaymentMethod.DEBIT_CARD, PaymentMethod.EWALLET],
  qrisMerchantName: 'KOPI NUSANTARA',
  paymentFees: { DEBIT_CARD: 0.007, CREDIT_CARD: 0.023, QRIS: 0.007, EWALLET: 0.015 },
};

async function main() {
  console.log('Seeding Kopi POS...');

  const branch = await prisma.branch.upsert({
    where: { code: 'BR01' },
    update: {},
    create: {
      code: 'BR01',
      name: 'Kopi Nusantara — Menteng',
      address: 'Jl. Merdeka No. 12, Jakarta Pusat',
      phone: '+62 21 5550 1234',
      isDefault: true,
    },
  });
  console.log(`  Branch: ${branch.name}`);

  const admin = await prisma.user.upsert({
    where: { email: env.SEED_ADMIN_EMAIL },
    update: { branchId: branch.id },
    create: {
      employeeCode: 'EMP0001',
      email: env.SEED_ADMIN_EMAIL,
      passwordHash: await hash(env.SEED_ADMIN_PASSWORD),
      fullName: 'System Administrator',
      role: Role.ADMIN,
      branchId: branch.id,
      hiredAt: new Date(),
    },
  });

  await prisma.user.upsert({
    where: { email: env.SEED_CASHIER_EMAIL },
    update: { branchId: branch.id },
    create: {
      employeeCode: 'EMP0002',
      email: env.SEED_CASHIER_EMAIL,
      passwordHash: await hash(env.SEED_CASHIER_PASSWORD),
      pinHash: await hash('1234'),
      fullName: 'Rina Cashier',
      role: Role.CASHIER,
      branchId: branch.id,
      hourlyRate: 25000,
      hiredAt: new Date(),
    },
  });
  console.log('  Users: admin + cashier');

  const supplier = await prisma.supplier.upsert({
    where: { name: 'PT Sumber Kopi Nusantara' },
    update: {},
    create: {
      name: 'PT Sumber Kopi Nusantara',
      contactName: 'Budi Santoso',
      phone: '+62 811 2233 4455',
      email: 'sales@sumberkopi.example',
      paymentTerm: 'Net 14',
    },
  });

  for (const spec of INGREDIENTS) {
    const ingredient = await prisma.ingredient.upsert({
      where: { sku: spec.sku },
      update: {},
      create: {
        sku: spec.sku,
        name: spec.name,
        unit: spec.unit,
        costPerUnit: spec.costPerUnit,
        lowStockAt: spec.lowStockAt,
        reorderQty: spec.reorderQty,
        supplierId: supplier.id,
      },
    });

    const existing = await prisma.inventoryStock.findUnique({
      where: { branchId_ingredientId: { branchId: branch.id, ingredientId: ingredient.id } },
    });

    if (!existing) {
      await prisma.inventoryStock.create({
        data: { branchId: branch.id, ingredientId: ingredient.id, quantity: spec.opening },
      });
      await prisma.stockMovement.create({
        data: {
          branchId: branch.id,
          ingredientId: ingredient.id,
          type: StockMovementType.OPENING,
          quantity: spec.opening,
          balanceAfter: spec.opening,
          unitCost: spec.costPerUnit,
          referenceType: 'SEED',
          note: 'Opening balance',
          userId: admin.id,
        },
      });
    }
  }
  console.log(`  Ingredients: ${INGREDIENTS.length} with opening stock`);

  const categoryMap = new Map<string, string>();
  for (const spec of CATEGORIES) {
    const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const category = await prisma.category.upsert({
      where: { name: spec.name },
      update: {},
      create: { ...spec, slug },
    });
    categoryMap.set(spec.name, category.id);
  }

  const ingredientMap = new Map(
    (await prisma.ingredient.findMany({ select: { id: true, sku: true } })).map((i) => [i.sku, i.id]),
  );

  for (const spec of PRODUCTS) {
    const existing = await prisma.product.findUnique({ where: { sku: spec.sku } });
    if (existing) continue;

    await prisma.product.create({
      data: {
        sku: spec.sku,
        barcode: spec.barcode ?? null,
        name: spec.name,
        categoryId: categoryMap.get(spec.category)!,
        basePrice: spec.price,
        isFavorite: spec.favorite ?? false,
        recipe: {
          create: spec.recipe.map((line) => ({
            ingredientId: ingredientMap.get(line.sku)!,
            quantity: line.quantity,
          })),
        },
        variants: spec.variants
          ? {
              create: spec.variants.map((v, index) => ({
                name: v.name,
                priceDelta: v.priceDelta,
                recipeMultiplier: v.multiplier,
                isDefault: v.isDefault ?? index === 0,
                sortOrder: index,
              })),
            }
          : undefined,
      },
    });
  }
  console.log(`  Products: ${PRODUCTS.length} with recipes`);

  for (const spec of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({ where: { name: spec.name }, update: {}, create: spec });
  }

  for (const [key, value] of Object.entries(SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as object, group: 'general' },
    });
  }

  await prisma.customer.upsert({
    where: { code: 'CUS00001' },
    update: {},
    create: { code: 'CUS00001', name: 'Walk-in Guest', note: 'Default customer for anonymous sales' },
  });

  console.log('\nSeed complete.');
  console.log(`  Admin   : ${env.SEED_ADMIN_EMAIL}`);
  console.log(`  Cashier : ${env.SEED_CASHIER_EMAIL} (POS PIN 1234)`);
  console.log('  Change these passwords before going live.\n');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
