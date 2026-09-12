import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ListChecks, ClipboardCheck, Settings, Users, ScrollText,
  Scale, Wallet, KeyRound, Receipt, Banknote, LogOut, Menu, X, Radio, Upload, Home, Building2, ArrowDownToLine, AlertTriangle,
  ArrowLeftRight, UserPlus, UserCircle,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { useSocket } from '@/hooks/useSocket';
import { NotificationBell } from '@/components/NotificationBell';
import { cn, ThemeToggle, UsdtRatePill } from '@/components/primitives';
import type { Role } from '@/types';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

const NAV: Record<Role, NavItem[]> = {
  ADMIN: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/review-queue', label: 'Review queue', icon: AlertTriangle },
    { to: '/admin/parties', label: 'Parties', icon: Building2 },
    { to: '/admin/captains', label: 'Captains', icon: Users },
    { to: '/admin/captain-registrations', label: 'Registrations', icon: UserPlus },
    { to: '/admin/transactions', label: 'Transactions', icon: Radio },
    { to: '/admin/funds', label: 'Funds & deposits', icon: ArrowLeftRight },
    { to: '/admin/commissions', label: 'Commissions', icon: Receipt },
    { to: '/admin/wallet', label: 'My wallet', icon: Wallet },
    { to: '/admin/reconciliation', label: 'Reconciliation', icon: Scale },
    { to: '/admin/logs', label: 'Audit log', icon: ScrollText },
    { to: '/admin/settings', label: 'Settings', icon: Settings },
  ],
  PARTY: [
    { to: '/party', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/party/audit', label: 'Audit desk', icon: ClipboardCheck },
    { to: '/party/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/party/import', label: 'Bulk import', icon: Upload },
    { to: '/party/wallet', label: 'Wallet', icon: Wallet },
    { to: '/party/transactions', label: 'API payments', icon: Radio },
    { to: '/party/api-keys', label: 'API keys', icon: KeyRound },
  ],
  CAPTAIN: [
    { to: '/captain', label: 'Home', icon: Home, end: true },
    { to: '/captain/payments', label: 'In progress', icon: ArrowLeftRight },
    { to: '/captain/queue', label: 'Payout', icon: Radio },
    { to: '/captain/tasks', label: 'My tasks', icon: ListChecks },
    { to: '/captain/earnings', label: 'Earnings', icon: Banknote },
    { to: '/captain/wallet', label: 'My wallet', icon: Wallet },
    { to: '/captain/pay-in', label: 'Pay In', icon: ArrowDownToLine },
    { to: '/captain/profile', label: 'My profile', icon: UserCircle },
  ],
};

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const { connected } = useSocket();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!user) return null;
  const items = NAV[user.role] ?? [];

  const handleSignOut = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-dvh bg-ink-950">
      {/* Desktop rail. Sticky and exactly one viewport tall, so the session
          footer stays pinned to the bottom of the screen instead of the bottom
          of the page — on a long tasks table, sign out was several screens
          down. The nav scrolls inside the rail if the role has more items than
          fit. */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900 lg:flex">
        <BrandMark />
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {items.map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </nav>
        <SessionFooter user={user} connected={connected} onSignOut={handleSignOut} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink-950/80"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <aside className="relative flex h-full w-64 flex-col border-r border-ink-800 bg-ink-900">
            <BrandMark onClose={() => setMobileOpen(false)} />
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" onClick={() => setMobileOpen(false)}>
              {items.map((item) => (
                <NavItemLink key={item.to} item={item} />
              ))}
            </nav>
            <SessionFooter user={user} connected={connected} onSignOut={handleSignOut} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/80 px-4 backdrop-blur lg:px-6">
          <button
            type="button"
            className="btn-ghost -ml-2 p-2 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          {/* Decorative on a phone — the drawer this button opens carries the
              brand mark already — and on a 320px screen it is the difference
              between the rate fitting and being clipped. */}
          <div className="hidden sm:block lg:hidden">
            <span className="font-display text-sm font-semibold text-ink-50">OTDMS</span>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* The live market rate, shared by every role — see UsdtRatePill.
                It shows on every screen size, phones included: it is the one
                number here people actually came to read.

                The header cannot hold both pills on a narrow phone, so the
                connection status is the one that steps aside — it is a
                diagnostic, and it is still there in the drawer's footer, which
                is where a phone user reaches everything else anyway. */}
            <UsdtRatePill />
            <ConnectionPill connected={connected} className="hidden sm:inline-flex" />
            <NotificationBell />
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-x-hidden px-4 py-5 lg:px-6 lg:py-6">{children}</main>
      </div>
    </div>
  );
}

function BrandMark({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-ink-800 px-4">
      <span className="relative flex h-6 w-6 items-center justify-center rounded-md bg-ink-800 ring-1 ring-ink-600">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-bold leading-none tracking-tight text-ink-50">OTDMS</p>
        <p className="mt-0.5 text-2xs font-mono uppercase tracking-wider text-ink-400">Operations</p>
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="btn-ghost p-1" aria-label="Close navigation">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors',
          isActive
            ? 'bg-brand-500/10 font-medium text-brand-500 shadow-rail'
            : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-brand-500' : 'text-ink-400')} strokeWidth={1.75} />
          <span className={cn(isActive && 'text-ink-50')}>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function ConnectionPill({ connected, className }: { connected: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1', className)}>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          connected ? 'bg-signal-green animate-pulse-dot' : 'bg-signal-slate',
        )}
      />
      <span className="text-2xs font-mono uppercase tracking-wider text-ink-300">
        {connected ? 'live' : 'offline'}
      </span>
    </span>
  );
}

function SessionFooter({
  user,
  connected,
  onSignOut,
}: {
  user: { name: string; email: string; role: Role };
  connected: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="border-t border-ink-800 p-3">
      <div className="mb-2 flex items-center gap-2.5 px-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-700 font-display text-xs font-semibold text-ink-100">
          {user.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-ink-100">{user.name}</p>
          <p className="truncate text-2xs font-mono uppercase tracking-wider text-ink-400">{user.role}</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onSignOut} className="btn-ghost flex-1 justify-start px-2 py-1.5 text-xs">
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
        <span className="lg:hidden">
          <ConnectionPill connected={connected} />
        </span>
      </div>
    </div>
  );
}
