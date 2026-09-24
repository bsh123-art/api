import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../core/logger';
import type { AccessTokenPayload } from '../modules/auth/auth.tokens';

let io: SocketServer | null = null;

export const RealtimeEvent = {
  OrderCreated: 'order:created',
  OrderVoided: 'order:voided',
  StockChanged: 'stock:changed',
  LowStock: 'stock:low',
  Notification: 'notification:new',
  DashboardTick: 'dashboard:tick',
} as const;

export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

export function initRealtime(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    path: '/realtime',
    serveClient: false,
  });

  // Sockets are authenticated with the same access token as the REST API and
  // are confined to their own branch room, so no cross-branch data leaks.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        issuer: 'kopi-pos',
        audience: 'kopi-pos-client',
      }) as AccessTokenPayload;
      socket.data.user = payload;
      return next();
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AccessTokenPayload;
    if (user.branchId) socket.join(`branch:${user.branchId}`);
    if (user.role === 'ADMIN' || user.role === 'MANAGER') socket.join('management');
    logger.debug({ userId: user.sub, branchId: user.branchId }, 'Realtime client connected');

    socket.on('disconnect', () => {
      logger.debug({ userId: user.sub }, 'Realtime client disconnected');
    });
  });

  return io;
}

export function emitToBranch(branchId: string | null | undefined, event: RealtimeEventName, payload: unknown): void {
  if (!io) return;
  const room = branchId ? `branch:${branchId}` : 'management';
  io.to(room).emit(event, payload);
  if (branchId) io.to('management').emit(event, { branchId, ...(payload as object) });
}

export function shutdownRealtime(): void {
  io?.close();
  io = null;
}
