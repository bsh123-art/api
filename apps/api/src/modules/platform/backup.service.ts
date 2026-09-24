import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import ExcelJS from 'exceljs';
import { env } from '../../config/env';
import { AppError, NotFoundError } from '../../core/errors';
import { logger } from '../../core/logger';
import { prisma } from '../../infra/prisma';

const backupDir = () => path.resolve(process.cwd(), env.BACKUP_DIR);

/** Only these characters may ever appear in a backup file name. */
const SAFE_NAME = /^kopi-backup-[0-9TZ:-]+\.(sql|json)$/;

const resolveSafePath = (fileName: string): string => {
  if (!SAFE_NAME.test(fileName)) throw new NotFoundError('Backup file');
  const target = path.resolve(backupDir(), fileName);
  // Defence in depth against path traversal even though the regex blocks it.
  if (!target.startsWith(backupDir() + path.sep)) throw new NotFoundError('Backup file');
  return target;
};

export async function listBackups() {
  await fs.mkdir(backupDir(), { recursive: true });
  const files = await fs.readdir(backupDir());

  const entries = await Promise.all(
    files
      .filter((f) => SAFE_NAME.test(f))
      .map(async (fileName) => {
        const stat = await fs.stat(path.join(backupDir(), fileName));
        return { fileName, sizeBytes: stat.size, createdAt: stat.mtime };
      }),
  );

  return entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Native `pg_dump` snapshot. Connection details are passed through the
 * environment rather than argv so the password never appears in the process
 * list of other users on the host.
 */
export async function createSqlBackup(): Promise<{ fileName: string; sizeBytes: number }> {
  await fs.mkdir(backupDir(), { recursive: true });
  const fileName = `kopi-backup-${new Date().toISOString().replace(/[.]/g, '-')}.sql`;
  const target = path.join(backupDir(), fileName);

  const url = new URL(env.DATABASE_URL);
  const pgEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGCONNECT_TIMEOUT: '15',
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn('pg_dump', ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--file', target], {
      env: pgEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `pg_dump exited with ${code}`))));
  }).catch((err) => {
    logger.error({ err }, 'pg_dump failed');
    throw new AppError(
      'Database dump failed. Ensure pg_dump is installed and reachable from the API container.',
      500,
      'BACKUP_FAILED',
    );
  });

  const stat = await fs.stat(target);
  return { fileName, sizeBytes: stat.size };
}

/** Portable JSON export — works anywhere, no pg_dump binary required. */
export async function createJsonBackup(): Promise<{ fileName: string; sizeBytes: number }> {
  await fs.mkdir(backupDir(), { recursive: true });

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    data: {
      branches: await prisma.branch.findMany(),
      categories: await prisma.category.findMany(),
      products: await prisma.product.findMany(),
      productVariants: await prisma.productVariant.findMany(),
      ingredients: await prisma.ingredient.findMany(),
      recipeItems: await prisma.recipeItem.findMany(),
      suppliers: await prisma.supplier.findMany(),
      inventoryStocks: await prisma.inventoryStock.findMany(),
      customers: await prisma.customer.findMany(),
      expenseCategories: await prisma.expenseCategory.findMany(),
      settings: await prisma.setting.findMany(),
      // Users are exported without credentials.
      users: await prisma.user.findMany({
        select: { id: true, employeeCode: true, email: true, fullName: true, role: true, status: true, branchId: true },
      }),
    },
  };

  const fileName = `kopi-backup-${new Date().toISOString().replace(/[.]/g, '-')}.json`;
  const target = path.join(backupDir(), fileName);
  await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');

  const stat = await fs.stat(target);
  return { fileName, sizeBytes: stat.size };
}

export function streamBackup(fileName: string) {
  const target = resolveSafePath(fileName);
  return { stream: createReadStream(target), fileName };
}

export async function deleteBackup(fileName: string) {
  await fs.unlink(resolveSafePath(fileName));
}

/** Removes snapshots older than the retention window. */
export async function pruneBackups(keepDays = 30): Promise<number> {
  const cutoff = Date.now() - keepDays * 86_400_000;
  const backups = await listBackups();
  const stale = backups.filter((b) => b.createdAt.getTime() < cutoff);
  await Promise.all(stale.map((b) => fs.unlink(path.join(backupDir(), b.fileName)).catch(() => undefined)));
  return stale.length;
}

// --------------------------------------------------------------------------
// Spreadsheet export
// --------------------------------------------------------------------------

export interface SheetSpec {
  name: string;
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, unknown>[];
}

/** Builds a styled multi-sheet workbook used by every "Export to Excel" action. */
export async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kopi POS';
  workbook.created = new Date();

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name.slice(0, 31));
    sheet.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
    sheet.addRows(spec.rows);

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6F4E37' } };
    sheet.getRow(1).alignment = { vertical: 'middle' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, spec.columns.length) } };
  }

  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}
