import { Server as SocketServer, type Socket } from 'socket.io';
import type http from 'node:http';
import cookie from 'cookie';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { verifyAccessToken, ACCESS_COOKIE } from '../services/token.service';
import { isSessionActive } from '../services/auth.service';
import { Captain } from '../models';
import type { AuthUser } from '../types';

let io: SocketServer | null = null;

/** Room naming is centralised so publishers and subscribers cannot drift. */
export const rooms = {
  role: (role: string) => `role:${role}`,
  user: (userId: string) => `user:${userId}`,
  captain: (captainId: string) => `captain:${captainId}`,
  party: (partyId: string) => `party:${partyId}`,
  /** Broadcast target for newly available tasks. */
  captainPool: 'pool:captains',
  /** Broadcast target for new withdrawal ("Pay In") requests any party can fulfil. */
  partyPool: 'pool:parties',
  admins: 'role:ADMIN',
};

interface AuthedSocket extends Socket {
  authUser?: AuthUser;
}

/**
 * The socket handshake is authenticated with the same HTTP-only cookie as the
 * REST API. An unauthenticated socket is rejected outright rather than being
 * allowed to connect and filtered later.
 */
export function initSockets(server: http.Server): SocketServer {
  io = new SocketServer(server, {
    cors: { origin: env.CLIENT_ORIGIN.split(','), credentials: true },
    path: '/socket.io',
    serveClient: false,
  });

  io.use(async (socket: AuthedSocket, next) => {
    try {
      const header = socket.handshake.headers.cookie;
      if (!header) return next(new Error('UNAUTHENTICATED'));

      const parsed = cookie.parse(header);
      const token = parsed[ACCESS_COOKIE];
      if (!token) return next(new Error('UNAUTHENTICATED'));

      const payload = verifyAccessToken(token);
      if (!(await isSessionActive(payload.sid))) return next(new Error('SESSION_EXPIRED'));

      socket.authUser = {
        userId: payload.sub,
        role: payload.role,
        email: payload.email,
        sessionId: payload.sid,
        ...(payload.partyId ? { partyId: payload.partyId } : {}),
        ...(payload.captainId ? { captainId: payload.captainId } : {}),
      };
      return next();
    } catch (err) {
      logger.warn({ err }, 'Socket authentication failed');
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const user = socket.authUser;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    // Join only the rooms this principal is entitled to.
    void socket.join(rooms.role(user.role));
    void socket.join(rooms.user(user.userId));
    if (user.captainId) {
      void socket.join(rooms.captain(user.captainId));
      void socket.join(rooms.captainPool);
    }
    if (user.partyId) {
      void socket.join(rooms.party(user.partyId));
      void socket.join(rooms.partyPool);
    }

    logger.debug({ userId: user.userId, role: user.role }, 'Socket connected');

    /** Captains toggle availability; only online captains receive task offers. */
    socket.on('captain:presence', async (payload: { online?: boolean }, ack?: (r: unknown) => void) => {
      try {
        if (user.role !== 'CAPTAIN' || !user.captainId) {
          ack?.({ success: false, message: 'Only captains can set presence' });
          return;
        }
        const online = Boolean(payload?.online);
        await Captain.updateOne(
          { _id: user.captainId },
          { $set: { isOnline: online, lastSeenAt: new Date() } },
        );
        if (online) {
          void socket.join(rooms.captainPool);
        } else {
          void socket.leave(rooms.captainPool);
        }
        emitToAdmins('captain:presence-changed', { captainId: user.captainId, online });
        ack?.({ success: true, data: { online } });
      } catch (err) {
        logger.error({ err }, 'Failed to update captain presence');
        ack?.({ success: false, message: 'Could not update presence' });
      }
    });

    socket.on('disconnect', () => {
      logger.debug({ userId: user.userId }, 'Socket disconnected');
    });
  });

  logger.info('Socket.io initialised');
  return io;
}

export function getIo(): SocketServer | null {
  return io;
}

function emit(room: string, event: string, payload: unknown): void {
  if (!io) return;
  io.to(room).emit(event, payload);
}

/**
 * Anything addressed to a captain, individually or as a pool.
 *
 * `externalRef` is the party's own tracking reference for the task. It is
 * need-to-know for the party and admin, and a captain must never receive it —
 * they could otherwise hand it straight to the customer. The serialisers
 * already strip it from every REST response; declaring it `never` here means
 * a socket payload cannot carry it either, and a future notification that
 * spreads the wrong shape fails to compile rather than leaking quietly.
 */
export type CaptainSafePayload = { externalRef?: never; [key: string]: unknown };

export function emitToCaptainPool(event: string, payload: CaptainSafePayload): void {
  emit(rooms.captainPool, event, payload);
}
export function emitToPartyPool(event: string, payload: unknown): void {
  emit(rooms.partyPool, event, payload);
}
export function emitToCaptain(captainId: string, event: string, payload: CaptainSafePayload): void {
  emit(rooms.captain(captainId), event, payload);
}
export function emitToParty(partyId: string, event: string, payload: unknown): void {
  emit(rooms.party(partyId), event, payload);
}
export function emitToAdmins(event: string, payload: unknown): void {
  emit(rooms.admins, event, payload);
}
export function emitToUser(userId: string, event: string, payload: unknown): void {
  emit(rooms.user(userId), event, payload);
}
