import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { useToast } from '@/components/Toast';
import { stateLabel } from '@/components/primitives';
import { playNotificationBeep } from '@/lib/beep';
import type { TaskState } from '@/types';

const SOCKET_URL = import.meta.env['VITE_SOCKET_URL'] ?? undefined;

export interface LiveEvent {
  id: string;
  event: string;
  message: string;
  taskCode?: string;
  at: number;
}

interface SocketContextValue {
  connected: boolean;
  events: LiveEvent[];
  clearEvents: () => void;
}

const SocketContext = createContext<SocketContextValue>({ connected: false, events: [], clearEvents: () => {} });

/**
 * One socket per session, owned here and shared via context. Any number of
 * components can call `useSocket()` — a nav bell, a dashboard panel, a live
 * activity feed — without opening a second connection or double-firing
 * toasts, which independent per-component connections used to do.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const toast = useToast();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    if (!user) return;

    const socket = SOCKET_URL
      ? io(SOCKET_URL, { withCredentials: true, transports: ['websocket', 'polling'] })
      : io({ withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    // Every notification-worthy event funnels through here, so this is the one
    // place the captain's audible alert has to hang off. A captain is out
    // making payments rather than watching the tab, so their notifications
    // beep; the other roles' do not.
    const isCaptain = user.role === 'CAPTAIN';
    const push = (event: string, message: string, taskCode?: string): void => {
      setEvents((prev) =>
        [{ id: `${Date.now()}-${Math.random()}`, event, message, taskCode, at: Date.now() }, ...prev].slice(0, 30),
      );
      if (isCaptain) playNotificationBeep();
    };

    const invalidate = (keys: string[]): void => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    };

    // A task offered to this captain alone, with a clock on it — distinct
    // from task:available, which only fires once routing gave up and opened
    // the task to everyone. See the server's taskRouting.service.ts.
    socket.on('task:offered', (p: { taskCode: string; commission?: number }) => {
      push('task:offered', `Task offered to you${p.commission ? ` — DMC ${p.commission}` : ''}`, p.taskCode);
      toast.show('info', `${p.taskCode} was offered to you — accept it before the window closes.`);
      invalidate(['captain-queue', 'captain-dashboard']);
    });
    socket.on('task:available', (p: { taskCode: string }) => {
      push('task:available', 'Task open to all captains', p.taskCode);
      invalidate(['captain-queue']);
    });
    socket.on('admin:task-unfulfilled', (p: { taskCode: string }) => {
      push('admin:task-unfulfilled', 'No captain accepted — task cancelled and party refunded', p.taskCode);
      invalidate(['admin-dashboard', 'admin-tasks']);
    });
    // A cache signal, not news. It reaches every connected captain so each one
    // can drop a card for work that is now taken — but one captain claiming a
    // task is not an event in another captain's day. Raising it as a
    // notification (and, for captains, a beep) meant each captain was told
    // what the other was doing, for tasks that were never theirs. Refresh
    // quietly instead.
    socket.on('task:claimed', () => {
      invalidate(['captain-queue', 'party-tasks', 'admin-tasks']);
    });
    socket.on('task:approved', (p: { taskCode: string; commission?: number }) => {
      push('task:approved', `Proof approved${p.commission ? ` — DMC ${p.commission} earned` : ''}`, p.taskCode);
      toast.show('success', `Proof approved for ${p.taskCode}`);
      invalidate(['captain-tasks', 'captain-earnings', 'captain-profile']);
    });
    socket.on('task:rejected', (p: { taskCode: string; reason?: string }) => {
      push('task:rejected', p.reason ?? 'Proof rejected', p.taskCode);
      toast.show('error', `Proof rejected for ${p.taskCode}`);
      invalidate(['captain-tasks', 'captain-profile', 'captain-queue']);
    });
    socket.on('task:expired', (p: { taskCode: string }) => {
      push('task:expired', 'Task expired', p.taskCode);
      invalidate(['captain-tasks', 'captain-profile']);
    });
    socket.on('captain:limit-updated', () => {
      invalidate(['captain-profile']);
    });
    socket.on('admin:audit-required', (p: { taskCode: string }) => {
      push('admin:audit-required', 'Audit required', p.taskCode);
      invalidate(['admin-audit-queue', 'admin-dashboard']);
    });
    socket.on('admin:task-created', (p: { taskCode: string }) => {
      push('admin:task-created', 'Task created', p.taskCode);
      invalidate(['admin-dashboard', 'admin-tasks']);
    });
    // The party's own view of a task moving through the lifecycle.
    socket.on('task:updated', (p: { taskCode: string; status: string }) => {
      push('task:updated', stateLabel(p.status as TaskState), p.taskCode);
      invalidate(['party-tasks', 'party-dashboard', 'party-audit-queue']);
    });
    socket.on('admin:config-updated', () => invalidate(['admin-settings']));
    socket.on('admin:captain-presence-changed', () => invalidate(['admin-dashboard', 'admin-captains', 'admin-captain-detail']));
    // A rejected proof or a disputed cancellation now needs admin's decision.
    socket.on('admin:task-rejected', (p: { taskCode: string; reason?: string }) => {
      push('admin:task-rejected', p.reason ?? 'Proof rejected — needs your review', p.taskCode);
      toast.show('info', `${p.taskCode} was rejected and needs your review.`);
      invalidate(['admin-review-queue', 'admin-dashboard']);
    });
    socket.on('admin:task-cancel-disputed', (p: { taskCode: string }) => {
      push('admin:task-cancel-disputed', 'Cancellation disputed — needs your review', p.taskCode);
      toast.show('info', `A disputed cancellation on ${p.taskCode} needs your review.`);
      invalidate(['admin-review-queue', 'admin-dashboard']);
    });
    // "Pay In" — a captain cashing out earned DMC. A withdrawal is split into
    // one portion per source party (see DMCAllocation.ts); each portion is
    // two-sided: that party pays and submits proof (captain is told to
    // verify), and only the captain's confirm/dispute is final for that
    // slice (party is told the outcome) — a dispute on one portion never
    // blocks another. Admin only ever observes this, never acts on it.
    socket.on('withdrawal:available', () => invalidate(['party-payin-pool']));
    socket.on('withdrawal:payment-submitted', (p: { amount?: number }) => {
      push('withdrawal:payment-submitted', 'A party says they paid you');
      toast.show('info', `A party says they paid your withdrawal${p.amount ? ` of DMC ${p.amount}` : ''} — please verify.`);
      invalidate(['captain-payins', 'captain-payin-portions']);
    });
    // Shared event names — a captain's Pay In and admin's own withdrawal both
    // fire these, so both sets of party-facing queries are invalidated.
    socket.on('withdrawal:fulfilled', (p: { amount?: number }) => {
      push('withdrawal:fulfilled', 'Payment confirmed');
      toast.show('success', `Your payment${p.amount ? ` of DMC ${p.amount}` : ''} was confirmed.`);
      invalidate(['party-payin-pool', 'party-payin-awaiting', 'party-payin-history', 'party-admin-withdrawal-pool']);
    });
    // Admin's ruling on a disputed portion — the only way out of DISPUTED.
    socket.on('withdrawal:dispute-resolved', (p: { amount?: number; message?: string }) => {
      push('withdrawal:dispute-resolved', p.message ?? 'A disputed payment was settled');
      toast.show('info', p.message ?? 'Admin settled a disputed payment.');
      invalidate([
        'party-payin-pool',
        'party-payin-awaiting',
        'party-payin-history',
        'party-payin-disputed',
        'captain-payins',
        'captain-payin-portions',
        'captain-profile',
      ]);
    });
    socket.on('withdrawal:disputed', (p: { amount?: number }) => {
      push('withdrawal:disputed', 'A payment was disputed');
      toast.show('error', `Your payment${p.amount ? ` of DMC ${p.amount}` : ''} was disputed.`);
      invalidate(['party-payin-awaiting', 'party-payin-disputed', 'party-admin-withdrawal-disputed']);
    });
    // Admin's own withdrawal — the same parent/portion, two-sided handshake as a captain's Pay In.
    socket.on('admin-withdrawal:available', () => invalidate(['party-admin-withdrawal-pool']));
    socket.on('admin:platform-withdrawal-payment-submitted', (p: { amount?: number }) => {
      push('admin:platform-withdrawal-payment-submitted', 'A party says they paid you');
      toast.show('info', `A party says they paid your withdrawal${p.amount ? ` of DMC ${p.amount}` : ''} — please verify.`);
      invalidate(['admin-withdrawals', 'admin-withdrawal-portions', 'admin-review-queue']);
    });
    // A party's DMC top-up — real money sent directly to admin to confirm.
    socket.on('admin:party-topup-requested', (p: { amount?: number }) => {
      push('admin:party-topup-requested', 'A party submitted a DMC top-up');
      toast.show('info', `A party submitted a top-up${p.amount ? ` of DMC ${p.amount}` : ''} — please verify.`);
      invalidate(['admin-topup-queue', 'admin-review-queue']);
    });
    socket.on('party-topup:decided', (p: { amount?: number; status?: string }) => {
      push('party-topup:decided', p.status === 'APPROVED' ? 'Your DMC top-up was confirmed' : 'Your DMC top-up was rejected');
      if (p.status === 'APPROVED') {
        toast.show('success', `Your top-up${p.amount ? ` of DMC ${p.amount}` : ''} was confirmed.`);
      } else {
        toast.show('error', `Your top-up${p.amount ? ` of DMC ${p.amount}` : ''} was rejected.`);
      }
      invalidate(['party-topups', 'party-dashboard']);
    });
    // Everything below lands in admin's review queue, which is the one screen
    // admin watches — so each of these has to refresh it, not just the panel it
    // came from. A captain disputing a payment used to refresh only that
    // captain's profile, where nobody was looking.
    socket.on('redemption:decided', (p: { amount?: number; status?: string; reason?: string | null }) => {
      const paid = p.status === 'PAID';
      push('redemption:decided', paid ? 'Your cash-out was paid' : 'Your cash-out was rejected');
      if (paid) {
        toast.show('success', `Your cash-out${p.amount ? ` of DMC ${p.amount}` : ''} was paid — check your account.`);
      } else {
        toast.show('error', p.reason ?? 'Your cash-out was rejected and the DMC is back in your balance.');
      }
      invalidate(['captain-redemptions', 'captain-profile', 'captain-dashboard']);
    });
    socket.on('wallet:converted', () => {
      invalidate(['captain-profile', 'captain-wallet-conversions', 'captain-dashboard']);
    });
    socket.on('admin:withdrawal-disputed', (p: { reason?: string }) => {
      push('admin:withdrawal-disputed', p.reason ?? 'A payment was disputed — needs your decision');
      toast.show('info', 'A withdrawal payment was disputed and needs your decision.');
      invalidate(['admin-review-queue', 'admin-captain-withdrawal-portions', 'admin-withdrawal-portions', 'admin-dashboard']);
    });
    socket.on('admin:collateral-deposit-requested', (p: { amount?: number }) => {
      push('admin:collateral-deposit-requested', 'A captain sent security money to confirm');
      toast.show('info', `A captain submitted security money${p.amount ? ` of DMC ${p.amount}` : ''} — please verify.`);
      invalidate(['admin-review-queue', 'admin-collateral-deposits']);
    });
    socket.on('admin:redemption-requested', (p: { amount?: number }) => {
      push('admin:redemption-requested', 'A captain is waiting to be paid out in rupees');
      toast.show('info', `A captain asked to cash out${p.amount ? ` DMC ${p.amount}` : ''} — please send it and confirm.`);
      invalidate(['admin-review-queue', 'admin-redemptions', 'admin-captain-detail']);
    });
    socket.on('admin:task-routing-stalled', (p: { taskCode: string }) => {
      push('admin:task-routing-stalled', 'No captain left who can take this task', p.taskCode);
      toast.show('info', `${p.taskCode} has run out of captains — it needs you.`);
      invalidate(['admin-review-queue', 'admin-tasks', 'admin-dashboard']);
    });

    // Task cancellation review — whichever side did NOT ask is told to review.
    socket.on('task:cancel-requested', (p: { taskCode: string }) => {
      push('task:cancel-requested', 'A cancellation needs your review', p.taskCode);
      toast.show('info', `A cancellation on ${p.taskCode} needs your review.`);
      // party-cancel-review-queue is the audit desk's second queue, where a
      // party answers a captain asking to drop a task.
      invalidate([
        'party-tasks',
        'party-task-detail',
        'party-cancel-review-queue',
        'captain-tasks',
        'captain-task-detail',
      ]);
    });
    socket.on('task:cancel-reviewed', (p: { taskCode: string }) => {
      push('task:cancel-reviewed', 'Cancellation decision updated', p.taskCode);
      invalidate([
        'party-tasks',
        'party-task-detail',
        'party-cancel-review-queue',
        'captain-tasks',
        'captain-task-detail',
      ]);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // toast and queryClient are stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <SocketContext.Provider value={{ connected, events, clearEvents: () => setEvents([]) }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket(): SocketContextValue {
  return useContext(SocketContext);
}
